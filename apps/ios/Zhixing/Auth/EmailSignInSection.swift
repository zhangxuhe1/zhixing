import Foundation
import SwiftUI

/// 邮箱验证码登录的纯逻辑（与视图同文件，便于 @testable 单测；视图见下方 EmailSignInSection）。
/// 服务端契约与安全参数见 apps/api/src/emailAuth.ts（EMAIL_CODE）与 apps/api/src/routes/auth.ts。
enum EmailAuthRules {
    /// 发送按钮冷却秒数。与服务端 EMAIL_CODE.cooldownMs（apps/api/src/emailAuth.ts，60s）
    /// 取值一致——send 成功仅返回 {ok:true}、不下发冷却秒数，倒计时全靠本常量；
    /// 改参数时两边同步（注释互指）。
    static let cooldownSeconds = 60

    /// 本地宽校验：trim 后须为「非空 local@非空 domain.非空 TLD」形态（各段不含空白与 @）。
    /// 严格校验交给服务端 zod（z.string().email()），此处只为提前兜住明显笔误。
    static func isValidEmail(_ raw: String) -> Bool {
        let s = raw.trimmingCharacters(in: .whitespaces)
        return s.wholeMatch(of: /[^@\s]+@[^@\s]+\.[^@\s]+/) != nil
    }

    /// 恰为 6 位数字（与服务端 EMAIL_CODE.length 一致）
    static func isValidCode(_ raw: String) -> Bool {
        raw.wholeMatch(of: /\d{6}/) != nil
    }

    /// 服务端故意合并错误面（防爆破，见 apps/api/src/emailAuth.ts 注释，勿为 UI 拆开）：
    /// 冷却/日限统一 429、错码/过期/锁死统一 401，均无细分信息。这里只按 HTTP status 映射、
    /// **禁止解析 body**——authRateLimit 插件的 429 体形与 {error} 不同，按 status 判别对两种体形都稳。
    static func message(for error: Error) -> String {
        if case let APIError.status(code, _) = error {
            switch code {
            case 429: return "操作太频繁，请稍后再试"
            case 401: return "验证码错误或已失效，请重新获取"
            default: break
            }
        }
        return "操作失败，请检查网络后重试"
    }
}

/// 发送按钮倒计时状态机。时间全部显式注入（无隐式 Date()），可单测；
/// 视图层用 Timer 每秒推一次 now 驱动刷新。
struct SendCooldown {
    private var until: Date?

    mutating func start(now: Date) {
        until = now.addingTimeInterval(TimeInterval(EmailAuthRules.cooldownSeconds))
    }

    /// 剩余秒数，向上取整（还剩 0.5s 显示 1，不显示 0 却仍禁用），到期后恒 0
    func remaining(now: Date) -> Int {
        guard let until, until > now else { return 0 }
        return Int(until.timeIntervalSince(now).rounded(.up))
    }

    func isCoolingDown(now: Date) -> Bool { remaining(now: now) > 0 }
}

/// 邮箱验证码登录区块（SignInScreen 只负责组装）。iOS 与 SIWA 并存；
/// Mac（Catalyst）上是唯一登录入口（ad-hoc 签不进 applesignin entitlement，SIWA 编译期裁掉）。
struct EmailSignInSection: View {
    @Environment(SessionStore.self) private var session
    @State private var email = ""
    @State private var code = ""
    @State private var cooldown = SendCooldown()
    @State private var now = Date()
    @State private var sending = false
    @State private var verifying = false
    @State private var error: String?

    /// 每秒推一次 now，驱动倒计时刷新（SendCooldown 自身不读隐式时间）
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                TextField("邮箱", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(sendTitle) { Task { await send() } }
                    .disabled(sending || cooldown.isCoolingDown(now: now)
                        || !EmailAuthRules.isValidEmail(email))
            }
            HStack(spacing: 8) {
                TextField("6 位验证码", text: $code)
                    .keyboardType(.numberPad)
                Button("登录") { Task { await verify() } }
                    .disabled(verifying || !EmailAuthRules.isValidCode(code))
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(.horizontal, 40)
        .onReceive(ticker) { now = $0 }
    }

    private var sendTitle: String {
        let remaining = cooldown.remaining(now: now)
        return remaining > 0 ? "重新发送(\(remaining)秒)" : "发送验证码"
    }

    private var trimmedEmail: String {
        email.trimmingCharacters(in: .whitespaces)
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            try await session.sendEmailCode(email: trimmedEmail)
            error = nil
            cooldown.start(now: Date())
        } catch {
            self.error = EmailAuthRules.message(for: error)
        }
    }

    private func verify() async {
        verifying = true
        defer { verifying = false }
        do {
            // 成功后无需任何导航：session.isSignedIn 翻转由 RootView 自动切主界面
            try await session.signInWithEmail(email: trimmedEmail, code: code)
            error = nil
        } catch {
            self.error = EmailAuthRules.message(for: error)
        }
    }
}
