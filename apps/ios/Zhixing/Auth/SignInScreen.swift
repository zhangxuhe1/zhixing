#if !targetEnvironment(macCatalyst)
import AuthenticationServices
#endif
import SwiftUI

struct SignInScreen: View {
    @Environment(SessionStore.self) private var session
    @State private var error: String?
    @ScaledMetric(relativeTo: .largeTitle) private var heroTitleSize: CGFloat = 52
    @ScaledMetric(relativeTo: .largeTitle) private var compactHeroTitleSize: CGFloat = 38

    var body: some View {
        GeometryReader { proxy in
            Group {
                if proxy.size.width >= 760 {
                    landscapeLayout
                        .padding(.horizontal, max(42, proxy.size.width * 0.055))
                        .padding(.vertical, 42)
                } else {
                    ScrollView {
                        compactLayout
                            .padding(.horizontal, 22)
                            .padding(.vertical, 18)
                    }
                    .scrollIndicators(.hidden)
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .background {
            fullBleedBackground
        }
        .preferredColorScheme(.light)
    }

    /// 背景通过 GeometryReader 的 `.background` 绘制，不参与前景内容的尺寸计算；
    /// 同时独立越过窗口安全区，避免 Catalyst 边缘露出默认白色底色。
    ///
    /// 尺寸锚点必须是 `ZXTheme.rice` 这个 `Color`：Color 永远精确铺满被提议的尺寸，
    /// 而底图作为它的 `.overlay` 不会反向撑大宿主。若把 `.scaledToFill()` 的 `Image`
    /// 直接当作 ZStack 的兄弟层，aspect-fill 的溢出会把整个背景（连同 rice）拽成
    /// 图片自身的宽高比——当窗口比图片更“高”（宽高比 < 图片）时背景会比窗口矮一截，
    /// 底部露白。这正是“某些窗口尺寸下才露白”的根因，故底图一律走 overlay + clipped。
    private var fullBleedBackground: some View {
        ZXTheme.rice
            .overlay {
                Image("LoginLandscape")
                    .resizable()
                    .scaledToFill()
            }
            .overlay {
                LinearGradient(
                    colors: [Color.black.opacity(0.28), Color.clear, ZXTheme.rice.opacity(0.10)],
                    startPoint: .leading,
                    endPoint: .trailing)
            }
            .clipped()
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }

    private var landscapeLayout: some View {
        HStack(spacing: 48) {
            hero(alignment: .leading, compact: false)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            authCard(compact: false)
                .frame(width: 410)
                .frame(maxHeight: .infinity, alignment: .center)
        }
    }

    private var compactLayout: some View {
        VStack(spacing: 20) {
            hero(alignment: .center, compact: true)
                .frame(maxWidth: .infinity)
            authCard(compact: true)
        }
    }

    private func hero(alignment: HorizontalAlignment, compact: Bool) -> some View {
        VStack(alignment: alignment, spacing: compact ? 12 : 18) {
            HStack(spacing: 12) {
                Image(systemName: "map.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 48, height: 48)
                    .foregroundStyle(ZXTheme.pineDeep)
                    .background(ZXTheme.rice.opacity(0.88), in: RoundedRectangle(cornerRadius: 14))
                Text("知行")
                    .font(.system(size: 29, weight: .bold, design: .serif))
                    .foregroundStyle(.white)
            }
            Text("知一方风土\n行万里山河")
                .font(.system(
                    size: compact ? compactHeroTitleSize : heroTitleSize,
                    weight: .semibold,
                    design: .serif))
                .foregroundStyle(.white)
                .lineSpacing(compact ? 4 : 8)
                .multilineTextAlignment(alignment == .center ? .center : .leading)
                .fixedSize(horizontal: false, vertical: true)
            Text("一张有故事的中国地图。\n去之前读懂它，离开后把故事留在这里。")
                .font(compact ? .body : .title3)
                .foregroundStyle(.white.opacity(0.86))
                .lineSpacing(compact ? 3 : 5)
                .multilineTextAlignment(alignment == .center ? .center : .leading)
                .fixedSize(horizontal: false, vertical: true)
            if !compact {
                Label("人文风物与私人足迹，在同一张地图相遇", systemImage: "map.fill")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white.opacity(0.82))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.black.opacity(0.16), in: Capsule())
            }
        }
    }

    private func authCard(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 18 : 22) {
            VStack(alignment: .leading, spacing: 7) {
                Text("继续你的地图")
                    .font(.system(.title2, design: .serif, weight: .bold))
                    .foregroundStyle(ZXTheme.ink)
                Text("用邮箱接收一次性验证码，无需设置密码。")
                    .font(.subheadline)
                    .foregroundStyle(Color.black.opacity(0.58))
            }

            // Mac（Catalyst）编译期裁掉 SIWA：ad-hoc 签名带不上 applesignin entitlement，
            // 按钮留着只会报错——Mac 版登录 = 邮箱验证码唯一入口
            #if !targetEnvironment(macCatalyst)
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = [.fullName]
            } onCompletion: { result in
                Task { await handle(result) }
            }
            .frame(height: 48)
            HStack {
                Rectangle().fill(Color.black.opacity(0.10)).frame(height: 1)
                Text("或使用邮箱")
                    .font(.caption)
                    .foregroundStyle(Color.black.opacity(0.46))
                    .fixedSize()
                Rectangle().fill(Color.black.opacity(0.10)).frame(height: 1)
            }
            #endif

            EmailSignInSection()

            if let error {
                ZXErrorBanner(message: error)
            }

            HStack(spacing: 7) {
                Image(systemName: "lock.fill")
                Text("你的足迹默认仅自己可见")
            }
            .font(.caption)
            .foregroundStyle(ZXTheme.pine.opacity(0.76))
            .frame(maxWidth: .infinity)

            #if DEBUG
            Button("开发登录（模拟器用）") {
                Task {
                    do { try await session.devLogin(sub: "simulator-dev") }
                    catch { self.error = error.localizedDescription }
                }
            }
            .font(.caption)
            .foregroundStyle(Color.black.opacity(0.45))
            .frame(maxWidth: .infinity)
            #endif
        }
        .padding(compact ? 22 : 30)
        .background(Color.white.opacity(0.90), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(Color.white.opacity(0.75), lineWidth: 1)
        }
        .shadow(color: ZXTheme.pineDeep.opacity(0.22), radius: 32, y: 18)
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
