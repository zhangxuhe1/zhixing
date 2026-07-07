import Foundation
import Observation
import UIKit

struct PhotoTranscodeError: LocalizedError {
    var errorDescription: String? { "无法处理所选照片" }
}

@MainActor
@Observable
final class FootprintStore {
    private(set) var footprints: [Footprint] = []
    private(set) var stats: Stats?

    var litPlaceIds: Set<String> { Set(footprints.map(\.placeId)) }

    func load() async {
        if let list: [Footprint] = try? await APIClient.shared.get("/me/footprints") {
            footprints = list
        }
        stats = try? await APIClient.shared.get("/me/stats")
    }

    private struct CreateBody: Encodable {
        let placeId: String
        let text: String?
        let date: Date
    }

    func create(placeId: String, text: String?, date: Date) async throws -> Footprint {
        let fp: Footprint = try await APIClient.shared.post(
            "/footprints", json: CreateBody(placeId: placeId, text: text, date: date))
        footprints.insert(fp, at: 0)
        return fp
    }

    /// 统一转 JPEG（PhotosPicker/相册可能给 HEIC；顺带压到上传友好的体积）
    func uploadPhoto(
        footprintId: String, imageData: Data,
        takenAt: Date? = nil, lat: Double? = nil, lng: Double? = nil
    ) async throws {
        guard let jpeg = UIImage(data: imageData)?.jpegData(compressionQuality: 0.85) else {
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

    func delete(_ footprint: Footprint) async {
        try? await APIClient.shared.delete("/footprints/\(footprint.id)")
        footprints.removeAll { $0.id == footprint.id }
        stats = try? await APIClient.shared.get("/me/stats")
    }
}
