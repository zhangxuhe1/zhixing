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
/// haversineMeters/matchRadius/nearestPin 见 Core/GeoMatch.swift（与 LocationOnce 选点共享）
func clusterAssets(_ assets: [AssetMeta], pins: [Pin], gap: TimeInterval = 48 * 3600) -> [DraftGroup] {
    var byPin: [String: (pin: Pin, assets: [AssetMeta])] = [:]
    for asset in assets {
        guard let pin = nearestPin(lat: asset.lat, lng: asset.lng, pins: pins) else { continue }
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
        case review
        case importing(done: Int, total: Int)
        case finished(created: Int, photos: Int)
    }

    var phase: Phase = .scanning
    var groups: [DraftGroup] = []
    var unmatchedCount = 0

    func scan(pins: [Pin]) async {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            phase = .denied
            return
        }
        let assets = Self.fetchAssetMetas()
        let matched = clusterAssets(assets, pins: pins)
        unmatchedCount = assets.count - matched.reduce(0) { $0 + $1.assets.count }
        groups = matched
        phase = .review
    }

    nonisolated static func fetchAssetMetas() -> [AssetMeta] {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        let result = PHAsset.fetchAssets(with: options)
        var metas: [AssetMeta] = []
        result.enumerateObjects { asset, _, _ in
            guard let location = asset.location, let date = asset.creationDate else { return }
            metas.append(AssetMeta(
                id: asset.localIdentifier, takenAt: date,
                lat: location.coordinate.latitude, lng: location.coordinate.longitude))
        }
        return metas
    }

    func runImport(store: FootprintStore) async {
        let chosen = groups.filter(\.include)
        var created = 0
        var photosUploaded = 0
        for (index, group) in chosen.enumerated() {
            phase = .importing(done: index, total: chosen.count)
            do {
                let fp = try await store.create(
                    placeId: group.pin.id, text: nil, date: group.start)
                for asset in group.assets.prefix(9) { // 每段足迹照片上限 9 张
                    if let data = await Self.imageData(localIdentifier: asset.id) {
                        try await store.uploadPhoto(
                            footprintId: fp.id, imageData: data,
                            takenAt: asset.takenAt, lat: asset.lat, lng: asset.lng)
                        photosUploaded += 1
                    }
                }
                created += 1
            } catch {
                continue // 单组失败不阻塞整体
            }
        }
        await store.load()
        phase = .finished(created: created, photos: photosUploaded)
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
