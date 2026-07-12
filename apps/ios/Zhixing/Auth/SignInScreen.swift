#if !targetEnvironment(macCatalyst)
import AuthenticationServices
#endif
import SwiftUI

struct SignInScreen: View {
    @Environment(SessionStore.self) private var session
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("知行").font(.system(size: 56, weight: .bold))
            Text("一张有故事的中国地图\n读懂每个地方，留下你的痕迹")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Spacer()
            // Mac（Catalyst）编译期裁掉 SIWA：ad-hoc 签名带不上 applesignin entitlement，
            // 按钮留着只会报错——Mac 版登录 = 邮箱验证码唯一入口
            #if !targetEnvironment(macCatalyst)
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = [.fullName]
            } onCompletion: { result in
                Task { await handle(result) }
            }
            .frame(height: 50)
            .padding(.horizontal, 40)
            Text("或使用邮箱验证码登录")
                .font(.footnote).foregroundStyle(.secondary)
            #endif
            EmailSignInSection()
            #if DEBUG
            Button("开发登录（模拟器用）") {
                Task {
                    do { try await session.devLogin(sub: "simulator-dev") }
                    catch { self.error = error.localizedDescription }
                }
            }
            .font(.footnote)
            #endif
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal)
            }
            Text("足迹默认仅自己可见").font(.caption2).foregroundStyle(.tertiary)
            Spacer().frame(height: 32)
        }
    }

    #if !targetEnvironment(macCatalyst)
    private func handle(_ result: Result<ASAuthorization, Error>) async {
        guard case let .success(auth) = result,
              let credential = auth.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            error = "Apple 登录未完成"
            return
        }
        let name = [credential.fullName?.familyName, credential.fullName?.givenName]
            .compactMap { $0 }.joined()
        do {
            try await session.signInWithApple(
                identityToken: token, nickname: name.isEmpty ? nil : name)
        } catch {
            self.error = error.localizedDescription
        }
    }
    #endif
}
