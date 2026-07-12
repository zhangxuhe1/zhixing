import XCTest
@testable import Zhixing

/// SessionStore 邮箱验证码登录端点方法的方法层验证。
/// 复用 APIClientMethodTests.swift 里的 StubURLProtocol（同 target 内 internal 可见），
/// 无网络依赖；测试串行执行，静态可变状态的线程安全责任同彼处说明。
final class EmailAuthTests: XCTestCase {
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
    func testSendEmailCodePostsEmailJSON() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"ok":true}"#.utf8))
        let session = SessionStore()
        try await session.sendEmailCode(email: "friend@example.com")
        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, "/auth/email/send")
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(
            StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "content-type"),
            "application/json")
        let json = try JSONSerialization.jsonObject(
            with: StubURLProtocol.lastBody ?? Data()) as? [String: Any]
        XCTAssertEqual(json?["email"] as? String, "friend@example.com")
    }

    @MainActor
    func testSignInWithEmailAppliesSessionOnSuccess() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(
            #"{"token":"jwt-123","user":{"id":"u1","nickname":"测试"}}"#.utf8))
        let session = SessionStore()
        // 清理 Keychain 与 APIClient.shared.token，防污染其他用例
        defer { session.signOut() }
        try await session.signInWithEmail(email: "friend@example.com", code: "123456")
        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, "/auth/email/verify")
        let json = try JSONSerialization.jsonObject(
            with: StubURLProtocol.lastBody ?? Data()) as? [String: Any]
        XCTAssertEqual(json?["email"] as? String, "friend@example.com")
        XCTAssertEqual(json?["code"] as? String, "123456")
        XCTAssertEqual(session.token, "jwt-123")
        XCTAssertTrue(session.isSignedIn)
    }

    @MainActor
    func testSignInWithEmailThrowsOn401AndKeepsSignedOut() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"invalid_code"}"#.utf8))
        let session = SessionStore()
        do {
            try await session.signInWithEmail(email: "friend@example.com", code: "000000")
            XCTFail("应抛出错误")
        } catch let APIError.status(code, _) {
            XCTAssertEqual(code, 401)
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
        XCTAssertNil(session.token)
        XCTAssertFalse(session.isSignedIn)
    }
}
