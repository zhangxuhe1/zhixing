import Foundation
import Observation
import Photos
import UIKit

struct AssetMeta: Identifiable, Equatable {
    let id: String // PHAsset.localIdentifier
    let takenAt: Date
    let lat: Double
    let lng: Double
}

struct DraftGroup: Identifiable {
    let id = UUID()
    let pin: Pin
    var assets: [AssetMeta] // 按 takenAt 升序
    var include = true
    var start: Date { assets.first?.takenAt ?? .now }
}

/// 按地点聚类；同地点内相邻照片间隔 > gap（默认 48h）拆成两段旅程
/// haversineMeters/matchRadius/nearestPin/wgs2gcj 见 Core/GeoMatch.swift（与 LocationOnce 选点共享）
func clusterAssets(_ assets: [AssetMeta], pins: [Pin], gap: TimeInterval = 48 * 3600) -> [DraftGroup] {
    var byPin: [String: (pin: Pin, assets: [AssetMeta])] = [:]
    for asset in assets {
        // EXIF 是 WGS-84,pin 是 GCJ-02:只在匹配查询时转换;AssetMeta 原始坐标不动,上传仍存 WGS
        let q = wgs2gcj(lat: asset.lat, lng: asset.lng)
        guard let pin = nearestPin(lat: q.lat, lng: q.lng, pins: pins) else { continue }
        byPin[pin.id, default: (pin, [])].assets.append(asset)
    }
    var groups: [DraftGroup] = []
    for entry in byPin.values {
        let sorted = entry.assets.sorted { $0.takenAt < $1.takenAt }
        var current: [AssetMeta] = []
        for asset in sorted {
            if let last = current.last, asset.takenAt.timeIntervalSince(last.takenAt) > gap {
                groups.append(DraftGroup(pin: entry.pin, assets: current))
                current = []
            }
            current.append(asset)
        }
        if !current.isEmpty {
            groups.append(DraftGroup(pin: entry.pin, assets: current))
        }
    }
    return groups.sorted { $0.start > $1.start }
}

@MainActor
@Observable
final class AlbumImportModel {
    enum Phase {
        case scanning
        case denied
        case restricted
        case review
        case importing(done: Int, total: Int)
        /// skippedIndices：本次导入里因"无法读取/无法解码"被跳过的照片，按跨组全局序号（1-based）记录，
        /// 供结束页汇总提示点名（item 9）。
        case finished(created: Int, photos: Int, skippedIndices: [Int])
    }

    var phase: Phase = .scanning
    var groups: [DraftGroup] = []
    var unmatchedCount = 0

    /// 只有用户可在系统设置里改回来的 denied 才需要在 App 重新活跃时复查。
    /// restricted 通常来自家长控制或设备策略，反复扫描既无效，也会误导用户。
    var needsAuthorizationRefresh: Bool {
        if case .denied = phase { return true }
        return false
    }

    func scan(pins: [Pin]) async {
        phase = .scanning
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard !Task.isCancelled else { return }
        switch status {
        case .authorized, .limited:
            break
        case .restricted:
            phase = .restricted
            return
        case .denied, .notDetermined:
            phase = .denied
            return
        @unknown default:
            phase = .restricted
            return
        }
        let assets = await Self.fetchAssetMetas()
        guard !Task.isCancelled else { return } // 扫描中途被取消：不再继续聚类/切换 phase，交由界面退出
        let matched = clusterAssets(assets, pins: pins)
        unmatchedCount = assets.count - matched.reduce(0) { $0 + $1.assets.count }
        groups = matched
        phase = .review
    }

    /// 后台枚举 + 协作式取消（item 1）：真正的相册枚举放进 `Task.detached`，脱钩到独立执行环境，
    /// 避免大相册枚举冻结主线程——冻住主线程的话，scanning 阶段的「取消」按钮点了也没法响应，
    /// 取消能力就是摆设。外层 Task 被取消时，`withTaskCancellationHandler` 把 `.cancel()` 转发给这个
    /// detached task；其内部在 `enumerateObjects` 的同步回调里查 `Task.isCancelled` 并置位 `stop`
    /// 指针，做到"发现取消就尽快真正停下来"而不是等全量枚举完才发现结果已经不需要了。
    static func fetchAssetMetas() async -> [AssetMeta] {
        let task = Task.detached(priority: .userInitiated) { () -> [AssetMeta] in
            let options = PHFetchOptions()
            options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
            let result = PHAsset.fetchAssets(with: options)
            var metas: [AssetMeta] = []
            result.enumerateObjects { asset, _, stop in
                if Task.isCancelled {
                    stop.pointee = true
                    return
                }
                guard let location = asset.location, let date = asset.creationDate else { return }
                metas.append(AssetMeta(
                    id: asset.localIdentifier, takenAt: date,
                    lat: location.coordinate.latitude, lng: location.coordinate.longitude))
            }
            return metas
        }
        return await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// 逐组导入；单张照片取不到字节（`imageData` 返回 nil，如 iCloud 下载失败/资源已损坏）或字节
    /// 取到了但解不出图片（`uploadPhoto` 抛 `PhotoTranscodeError`）都跳过、继续队列里的下一张，
    /// 不再让一张坏图卡死整段甚至整个导入（item 9）；`photosUploaded` 只在上传真正成功后才 +1，
    /// 跳过的不计入，避免中途失败把计数往高偏（item 8）。序号用跨组全局位置，供结束页点名。
    func runImport(store: FootprintStore) async {
        let chosen = groups.filter(\.include)
        var created = 0
        var photosUploaded = 0
        var skippedIndices: [Int] = []
        var globalIndex = 0
        for (index, group) in chosen.enumerated() {
            phase = .importing(done: index, total: chosen.count)
            do {
                let fp = try await store.create(
                    placeId: group.pin.id, text: nil, date: group.start)
                for asset in group.assets.prefix(9) { // 每段足迹照片上限 9 张
                    globalIndex += 1
                    guard let data = await Self.imageData(localIdentifier: asset.id) else {
                        skippedIndices.append(globalIndex)
                        continue
                    }
                    do {
                        // sanitized: true——data 来自 Self.imageData 的 UIImage.jpegData(0.8) 重编码，
                        // 构造上不含 EXIF（GPS/拍摄时间已随 UIImage 解码丢弃），够格直通免二次压缩。
                        try await store.uploadPhoto(
                            footprintId: fp.id, imageData: data, sanitized: true,
                            takenAt: asset.takenAt, lat: asset.lat, lng: asset.lng)
                        photosUploaded += 1
                    } catch is PhotoTranscodeError {
                        skippedIndices.append(globalIndex)
                    }
                }
                created += 1
            } catch {
                continue // 单组失败（如建足迹本身失败）不阻塞整体
            }
        }
        await store.load()
        phase = .finished(created: created, photos: photosUploaded, skippedIndices: skippedIndices)
    }

    nonisolated static func imageData(localIdentifier: String) async -> Data? {
        guard let asset = PHAsset.fetchAssets(
            withLocalIdentifiers: [localIdentifier], options: nil).firstObject else { return nil }
        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat // 单次回调，防 continuation 重复 resume
            options.isNetworkAccessAllowed = true // iCloud 照片可下载
            PHImageManager.default().requestImage(
                for: asset, targetSize: CGSize(width: 1600, height: 1600),
                contentMode: .aspectFit, options: options
            ) { image, _ in
                continuation.resume(returning: image?.jpegData(compressionQuality: 0.8))
            }
        }
    }
}
