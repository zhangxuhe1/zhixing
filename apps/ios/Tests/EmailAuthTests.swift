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
        // 清理持久会话与 APIClient.shared.token，防污染其他用例
        defer { try? session.signOut() }
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
    func testEmailSessionRestoresFromPersistentStoreAfterNewSessionInstance() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhixing-email-restore-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let tokenStore = FileSessionTokenStore(directory: directory)

        StubURLProtocol.stub = .init(status: 200, body: Data(
            #"{"token":"jwt-persisted","user":{"id":"u1","nickname":"测试"}}"#.utf8))
        let signedIn = SessionStore(tokenStore: tokenStore)
        try await signedIn.signInWithEmail(email: "friend@example.com", code: "123456")
        XCTAssertEqual(try tokenStore.load(), "jwt-persisted")

        // 模拟进程重启：不用原 SessionStore，新实例只能从持久层恢复。
        StubURLProtocol.stub = .init(status: 200, body: Data(
            #"{"id":"u1","nickname":"测试"}"#.utf8))
        let restored = SessionStore(tokenStore: tokenStore)
        await restored.restore()

        XCTAssertFalse(restored.restoring)
        XCTAssertTrue(restored.isSignedIn)
        XCTAssertEqual(restored.token, "jwt-persisted")
        XCTAssertEqual(restored.user?.id, "u1")
        XCTAssertEqual(
            StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "authorization"),
            "Bearer jwt-persisted")
        try restored.signOut()
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

    @MainActor
    func testUserSignOutFailureKeepsSessionAndCompensatesPersistentToken() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(
            #"{"token":"jwt-stays-signed-in","user":{"id":"u1","nickname":"测试"}}"#.utf8))
        let tokenStore = InMemorySessionTokenStore()
        let session = SessionStore(tokenStore: tokenStore)
        try await session.signInWithEmail(email: "friend@example.com", code: "123456")
        tokenStore.deleteError = CocoaError(.fileWriteNoPermission)

        XCTAssertThrowsError(try session.signOut())
        XCTAssertTrue(session.isSignedIn)
        XCTAssertEqual(session.token, "jwt-stays-signed-in")
        XCTAssertEqual(APIClient.shared.token, "jwt-stays-signed-in")
        XCTAssertEqual(tokenStore.token, "jwt-stays-signed-in")
        XCTAssertEqual(tokenStore.savedTokens, ["jwt-stays-signed-in", "jwt-stays-signed-in"])

        tokenStore.deleteError = nil
        try session.signOut()
        XCTAssertFalse(session.isSignedIn)
        XCTAssertNil(APIClient.shared.token)
        XCTAssertNil(tokenStore.token)
    }

    @MainActor
    func testExpiredSessionClearsMemoryEvenWhenPersistentDeleteFails() async {
        let tokenStore = InMemorySessionTokenStore(token: "jwt-expired")
        tokenStore.deleteError = CocoaError(.fileWriteNoPermission)
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"unauthorized"}"#.utf8))
        let session = SessionStore(tokenStore: tokenStore)

        await session.restore()

        XCTAssertFalse(session.isSignedIn)
        XCTAssertNil(session.token)
        XCTAssertNil(APIClient.shared.token)
        XCTAssertEqual(tokenStore.token, "jwt-expired")
    }
}
