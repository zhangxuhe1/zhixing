import Foundation

enum APIError: Error, LocalizedError {
    case status(Int, String)
    var errorDescription: String? {
        if case let .status(code, body) = self { return "HTTP \(code)：\(body.prefix(120))" }
        return nil
    }
}

/// 与服务端 @fastify/multipart 兼容的 multipart/form-data 编码（纯函数，可单测）
func multipartBody(
    boundary: String, fields: [String: String],
    filename: String, mime: String, fileData: Data
) -> Data {
    var body = Data()
    func append(_ s: String) { body.append(Data(s.utf8)) }
    for (key, value) in fields.sorted(by: { $0.key < $1.key }) {
        append("--\(boundary)\r\ncontent-disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n")
    }
    append("--\(boundary)\r\ncontent-disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\ncontent-type: \(mime)\r\n\r\n")
    body.append(fileData)
    append("\r\n--\(boundary)--\r\n")
    return body
}

@MainActor
final class APIClient {
    static let shared = APIClient()
    var token: String?

    nonisolated static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            if let date = withFraction.date(from: s) ?? plain.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath, debugDescription: "无法解析日期 \(s)"))
        }
        return d
    }()

    nonisolated static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path: path, method: "GET", body: nil, contentType: nil)
    }

    func post<T: Decodable>(_ path: String, json: some Encodable) async throws -> T {
        try await send(path: path, method: "POST",
                       body: try Self.encoder.encode(json), contentType: "application/json")
    }

    /// 无 body、不关心响应体，只要求 2xx（如浏览打点 `POST /footprints/:id/view`）。
    func post(_ path: String) async throws {
        _ = try await raw(path: path, method: "POST", body: nil, contentType: nil)
    }

    func delete(_ path: String) async throws {
        _ = try await raw(path: path, method: "DELETE", body: nil, contentType: nil)
    }

    func put(_ path: String) async throws {
        _ = try await raw(path: path, method: "PUT", body: nil, contentType: nil)
    }

    func patch<T: Decodable>(_ path: String, json: some Encodable) async throws -> T {
        try await send(path: path, method: "PATCH",
                       body: try Self.encoder.encode(json), contentType: "application/json")
    }

    func upload<T: Decodable>(
        _ path: String, file: Data, filename: String, mime: String, fields: [String: String]
    ) async throws -> T {
        let boundary = "zx-\(UUID().uuidString)"
        let body = multipartBody(boundary: boundary, fields: fields,
                                 filename: filename, mime: mime, fileData: file)
        return try await send(path: path, method: "POST", body: body,
                              contentType: "multipart/form-data; boundary=\(boundary)")
    }

    private func send<T: Decodable>(
        path: String, method: String, body: Data?, contentType: String?
    ) async throws -> T {
        let data = try await raw(path: path, method: method, body: body, contentType: contentType)
        return try Self.decoder.decode(T.self, from: data)
    }

    private func raw(
        path: String, method: String, body: Data?, contentType: String?
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: AppConfig.apiBase) else {
            throw APIError.status(0, "非法路径 \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.httpBody = body
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "content-type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, response) = try await URLSession.shared.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(code) else {
            throw APIError.status(code, String(decoding: data, as: UTF8.self))
        }
        return data
    }
}
