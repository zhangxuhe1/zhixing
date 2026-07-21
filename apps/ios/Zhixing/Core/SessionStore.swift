import Foundation
import Observation
import os

@MainActor
@Observable
final class SessionStore {
    private static let logger = Logger(subsystem: "app.zhixing.ios", category: "SessionStore")
    static let signOutFailureMessage = "无法安全删除本机登录信息，请稍后重试。为保护账号，你仍保持登录状态。"
    private let tokenStore: any SessionTokenStore
    private(set) var user: User?
    private(set) var token: String?
    private(set) var restoring = true

    var isSignedIn: Bool { token != nil }

    init(tokenStore: any SessionTokenStore = DefaultSessionTokenStore()) {
        self.tokenStore = tokenStore
    }

    func restore() async {
        defer { restoring = false }
        let saved: String
        do {
            guard let token = try tokenStore.load() else { return }
            saved = token
        } catch {
            Self.logger.error("恢复持久会话失败：\(error.localizedDescription, privacy: .public)")
            return
        }
        token = saved
        APIClient.shared.token = saved
        do {
            user = try await APIClient.shared.get("/me")
        } catch let APIError.status(code, _) where code == 401 {
            invalidateExpiredSession() // token 已失效才清；网络错误保持登录态
        } catch {}
    }

    private struct AppleBody: Encodable { let identityToken: String; let nickname: String? }
    func signInWithApple(identityToken: String, nickname: String?) async throws {
        try apply(try await APIClient.shared.post(
            "/auth/apple", json: AppleBody(identityToken: identityToken, nickname: nickname)))
    }

    // 邮箱验证码登录（服务端契约见 apps/api/src/routes/auth.ts）。verify 成功后与 SIWA
    // 汇合于同一 apply()/SessionTokenStore 存储路径，后续请求无差别。失败一律上抛 APIError.status，
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
        try apply(try await APIClient.shared.post(
            "/auth/email/verify", json: EmailVerifyBody(email: email, code: code)))
    }

    private struct DevBody: Encodable { let appleSub: String }
    func devLogin(sub: String) async throws {
        try apply(try await APIClient.shared.post("/auth/dev", json: DevBody(appleSub: sub)))
    }

    /// 用户主动退出必须先确认持久层已删除，再翻转 UI 状态。
    ///
    /// Catalyst 同时清 Keychain 与文件，任一失败都可能导致冷启动恢复旧会话；删除失败时尽力把
    /// 当前 token 补写回去，并保持本次登录态，让界面明确提示用户重试，而不是制造“假退出”。
    func signOut() throws {
        let currentToken = token
        do {
            try tokenStore.delete()
        } catch {
            if let currentToken {
                do { try tokenStore.save(currentToken) }
                catch {
                    Self.logger.fault("退出失败后的会话补偿保存也失败：\(error.localizedDescription, privacy: .public)")
                }
            }
            throw error
        }
        clearInMemorySession()
    }

    /// 服务端 401 已证明 token 无效，即使本地删除失败也不能继续把它当作已登录会话。
    private func invalidateExpiredSession() {
        do { try tokenStore.delete() }
        catch { Self.logger.error("删除失效会话失败：\(error.localizedDescription, privacy: .public)") }
        clearInMemorySession()
    }

    private func clearInMemorySession() {
        token = nil
        user = nil
        APIClient.shared.token = nil
    }

    private func apply(_ auth: AuthResponse) throws {
        // 先落盘再翻转 UI 登录态，避免存储失败时制造“这次成功、下次又掉线”的假成功。
        // save 可能在主存储已写入、降级协调失败时抛错：内存态保持未登录；下次冷启动
        // 若主存储可读且协调成功，restore() 可能恢复该会话——这是可接受的恢复路径。
        try tokenStore.save(auth.token)
        token = auth.token
        user = auth.user
        APIClient.shared.token = auth.token
    }
}
