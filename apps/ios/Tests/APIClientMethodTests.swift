import XCTest
@testable import Zhixing

/// 拦截 URLSession.shared 请求的测试替身：通过全局注册 URLProtocol 生效，
/// 无需改动 APIClient 生产实现即可对 put/patch 做无网络依赖的方法层验证。
/// 测试串行执行（未启用并行测试），静态可变状态用 nonisolated(unsafe) 承担线程安全责任。
final class StubURLProtocol: URLProtocol {
    struct Stub {
        let status: Int
        let body: Data
    }

    nonisolated(unsafe) static var stub: Stub?
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        Self.lastBody = Self.readBody(from: request)
        guard let stub = Self.stub else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "http://localhost")!,
            statusCode: stub.status, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// URLSession 转发给 URLProtocol 时常把 httpBody 转成 httpBodyStream，两路都读一遍。
    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class APIClientMethodTests: XCTestCase {
    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(StubURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(StubURLProtocol.self)
        StubURLProtocol.stub = nil
        StubURLProtocol.lastRequest = nil
        StubURLProtocol.lastBody = nil
        super.tearDown()
    }

    @MainActor
    func testPutSendsNoBodyAndSucceedsOn2xx() async throws {
        StubURLProtocol.stub = .init(status: 204, body: Data())
        try await APIClient.shared.put("/footprints/f1/like")
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "PUT")
        XCTAssertNil(StubURLProtocol.lastBody)
    }

    @MainActor
    func testPutThrowsOnNon2xx() async {
        StubURLProtocol.stub = .init(status: 404, body: Data("not_found".utf8))
        do {
            try await APIClient.shared.put("/footprints/missing/like")
            XCTFail("应抛出错误")
        } catch let APIError.status(code, body) {
            XCTAssertEqual(code, 404)
            XCTAssertTrue(body.contains("not_found"))
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }

    /// 无 json 参数的 post(_:)：ViewTracker 默认 send（POST /footprints/:id/view）依赖此方法，与 put 同形状。
    @MainActor
    func testPostWithoutJSONSendsNoBodyAndSucceedsOn2xx() async throws {
        StubURLProtocol.stub = .init(status: 204, body: Data())
        try await APIClient.shared.post("/footprints/f1/view")
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertNil(StubURLProtocol.lastBody)
    }

    @MainActor
    func testPostWithoutJSONThrowsOnNon2xx() async {
        StubURLProtocol.stub = .init(status: 404, body: Data("not_found".utf8))
        do {
            try await APIClient.shared.post("/footprints/missing/view")
            XCTFail("应抛出错误")
        } catch let APIError.status(code, body) {
            XCTAssertEqual(code, 404)
            XCTAssertTrue(body.contains("not_found"))
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }

    private struct Ping: Codable, Equatable { let ok: Bool }
    private struct Payload: Encodable { let text: String }

    @MainActor
    func testPatchSendsJSONBodyAndDecodesResponse() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"ok":true}"#.utf8))
        let result: Ping = try await APIClient.shared.patch("/footprints/f1", json: Payload(text: "hi"))
        XCTAssertEqual(result, Ping(ok: true))
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "PATCH")
        XCTAssertEqual(StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "content-type"), "application/json")
        let sentJSON = try JSONSerialization.jsonObject(with: StubURLProtocol.lastBody ?? Data()) as? [String: Any]
        XCTAssertEqual(sentJSON?["text"] as? String, "hi")
    }

    @MainActor
    func testPatchThrowsOnNon2xx() async {
        StubURLProtocol.stub = .init(status: 400, body: Data("invalid_body".utf8))
        do {
            let _: Ping = try await APIClient.shared.patch("/footprints/f1", json: Payload(text: "hi"))
            XCTFail("应抛出错误")
        } catch let APIError.status(code, body) {
            XCTAssertEqual(code, 400)
            XCTAssertTrue(body.contains("invalid_body"))
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }
}
