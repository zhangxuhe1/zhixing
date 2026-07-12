import Foundation
import Observation

@MainActor
@Observable
final class SessionStore {
    private(set) var user: User?
    private(set) var token: String?
    private(set) var restoring = true

    var isSignedIn: Bool { token != nil }

    func restore() async {
        defer { restoring = false }
        guard let saved = Keychain.load(key: "token") else { return }
        token = saved
        APIClient.shared.token = saved
        do {
            user = try await APIClient.shared.get("/me")
        } catch let APIError.status(code, _) where code == 401 {
            signOut() // token 过期才登出；网络错误保持登录态
        } catch {}
    }

    private struct AppleBody: Encodable { let identityToken: String; let nickname: String? }
    func signInWithApple(identityToken: String, nickname: String?) async throws {
        apply(try await APIClient.shared.post(
            "/auth/apple", json: AppleBody(identityToken: identityToken, nickname: nickname)))
    }

    // 邮箱验证码登录（服务端契约见 apps/api/src/routes/auth.ts）。verify 成功后与 SIWA
    // 汇合于同一 apply()/Keychain 存储路径，后续请求无差别。失败一律上抛 APIError.status，
    // 中文文案映射在 EmailAuthRules（按 HTTP status，不解析 body）。
    private struct EmailSendBody: Encodable { let email: String }
    private struct EmailSendOk: Decodable { let ok: Bool }
    /// send 成功仅返回 {ok:true}、不下发冷却秒数——倒计时由客户端常量驱动（EmailAuthRules.cooldownSeconds）
    func sendEmailCode(email: String) async throws {
        let _: EmailSendOk = try await APIClient.shared.post(
            "/auth/email/send", json: EmailSendBody(email: email))
    }

    private struct EmailVerifyBody: Encodable { let email: String; let code: String }
    func signInWithEmail(email: String, code: String) async throws {
        apply(try await APIClient.shared.post(
            "/auth/email/verify", json: EmailVerifyBody(email: email, code: code)))
    }

    private struct DevBody: Encodable { let appleSub: String }
    func devLogin(sub: String) async throws {
        apply(try await APIClient.shared.post("/auth/dev", json: DevBody(appleSub: sub)))
    }

    func signOut() {
        token = nil
        user = nil
        APIClient.shared.token = nil
        Keychain.delete(key: "token")
    }

    private func apply(_ auth: AuthResponse) {
        token = auth.token
        user = auth.user
        APIClient.shared.token = auth.token
        Keychain.save(auth.token, key: "token")
    }
}
