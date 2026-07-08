import Foundation
import Observation
import UIKit

struct PhotoTranscodeError: LocalizedError {
    var errorDescription: String? { "无法处理所选照片" }
}

extension Data {
    /// 仅看 FF D8 魔数前缀——足够区分"已经是 JPEG"与其他格式，不需要完整解码。
    var isJPEG: Bool {
        count >= 2 && self[startIndex] == 0xFF && self[index(after: startIndex)] == 0xD8
    }
}

/// 上传前的照片字节准备（纯函数，可单测；I10 评审修复）。
/// - `sanitized: true`：调用方声明这份数据是"我们自产、构造上就不含 EXIF"的——目前仅相册导入
///   路径（`AlbumImporter.imageData` 经 `UIImage.jpegData(0.8)` 重编码产出，`UIImage` 解码即丢弃
///   GPS/拍摄时间等元数据）。此时已是 JPEG 就字节直通，避免双重有损压缩（item 2 的修复保留）。
/// - `sanitized: false`：来源是用户任选的原始文件字节（如 PhotosPicker 的 `loadTransferable`，
///   JPEG 原图会原封不动带着 GPS/DateTimeOriginal 等 EXIF）。必须无条件经 `UIImage` 解码重编码
///   剥掉元数据——服务端按设计零图像处理栈、字节原样存储并对全体登录用户 presign，脱敏只能发生
///   在客户端这一层（§5.1：lat/lng/takenAt 同族数据严禁随公开面外泄）。
func preparedPhotoUploadData(_ imageData: Data, sanitized: Bool) -> Data? {
    if sanitized, imageData.isJPEG { return imageData }
    return UIImage(data: imageData)?.jpegData(compressionQuality: 0.85)
}

@MainActor
@Observable
final class FootprintStore {
    private(set) var footprints: [Footprint] = []
    private(set) var stats: Stats?

    var litPlaceIds: Set<String> { Set(footprints.map(\.placeId)) }

    /// 足迹列表与 stats 各自独立请求，失败一律保留旧值不清零——网络抖动不该让"已经加载过"的数据
    /// 在界面上闪回空/零（两路径对称：都用 if let 只在成功时才落地新值）。
    func load() async {
        if let list: [Footprint] = try? await APIClient.shared.get("/me/footprints") {
            footprints = list
        }
        if let s: Stats = try? await APIClient.shared.get("/me/stats") {
            stats = s
        }
    }

    private struct CreateBody: Encodable {
        let placeId: String
        let text: String?
        let date: Date
        let visibility: String?
    }

    func create(placeId: String, text: String?, date: Date, visibility: String? = nil) async throws -> Footprint {
        let fp: Footprint = try await APIClient.shared.post(
            "/footprints", json: CreateBody(placeId: placeId, text: text, date: date, visibility: visibility))
        footprints.insert(fp, at: 0)
        return fp
    }

    /// PATCH `/footprints/:id` 请求体。
    /// `text` 用双重可选实现三态语义：外层 nil＝不带该键（不改）；外层非 nil、内层 nil＝带 JSON null（清空）；
    /// 外层非 nil、内层非 nil＝带新字符串值。`date`/`visibility` 是单层可选：nil＝不带该键，非 nil＝带新值。
    /// 不是私有类型——测试需要从 ModelsTests 直接构造它来对编码结果做键存在性断言。
    struct UpdateBody: Encodable {
        let text: String??
        let date: Date?
        let visibility: String?
    }

    /// 服务端行为地雷（终审备案 M3）：PATCH visibility:"PUBLIC" 对已 APPROVED 的足迹会无条件重排队（回 PENDING）。
    /// 调用方必须只在对应字段真的发生变更时才传非 nil，尤其是 visibility——开关没动就必须传 nil，否则会把
    /// 已通过审核的公开足迹意外打回“审核中”。成功后就地替换 `footprints` 中的对应元素，供列表页立即刷新。
    func update(id: String, text: String??, date: Date?, visibility: String?) async throws -> Footprint {
        let updated: Footprint = try await APIClient.shared.patch(
            "/footprints/\(id)", json: UpdateBody(text: text, date: date, visibility: visibility))
        if let index = footprints.firstIndex(where: { $0.id == id }) {
            footprints[index] = updated
        }
        return updated
    }

    /// 统一转 JPEG（PhotosPicker/相册可能给 HEIC；顺带压到上传友好的体积）。
    /// `sanitized` 语义与直通/重编码的取舍见 `preparedPhotoUploadData`——刻意不给默认值：
    /// 这是隐私攸关的决定，每个新调用点都必须显式声明自己的字节来源是否已脱敏（EXIF-free），
    /// 免得未来路径顺手省参数、又把带 GPS 的原图直通上去。
    func uploadPhoto(
        footprintId: String, imageData: Data, sanitized: Bool,
        takenAt: Date? = nil, lat: Double? = nil, lng: Double? = nil
    ) async throws {
        guard let jpeg = preparedPhotoUploadData(imageData, sanitized: sanitized) else {
            throw PhotoTranscodeError()
        }
        var fields: [String: String] = [:]
        if let takenAt { fields["takenAt"] = ISO8601DateFormatter().string(from: takenAt) }
        if let lat { fields["lat"] = String(lat) }
        if let lng { fields["lng"] = String(lng) }
        let _: FootprintPhotoMeta = try await APIClient.shared.upload(
            "/footprints/\(footprintId)/photos",
            file: jpeg, filename: "photo.jpg", mime: "image/jpeg", fields: fields)
    }

    /// 服务端删除失败就不再假装删了——之前的实现无论成败都本地移除，会让用户以为删除成功、
    /// 刷新/重启后那条足迹却又"复活"。throws 上抛，由调用界面（MeScreen）展示错误（关闭台账 I7 Minor）。
    func delete(_ footprint: Footprint) async throws {
        try await APIClient.shared.delete("/footprints/\(footprint.id)")
        footprints.removeAll { $0.id == footprint.id }
        if let s: Stats = try? await APIClient.shared.get("/me/stats") {
            stats = s
        }
    }

    func reset() {
        footprints = []
        stats = nil
    }
}
