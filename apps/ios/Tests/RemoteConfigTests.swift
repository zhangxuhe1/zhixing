import XCTest
@testable import Zhixing

/// RemoteConfig 契约：`shareLandingUrl` 在任何 `load()` 之前就已经是内置占位常量（不是 nil/空串）；
/// `load()` 取 `GET /app-config` 成功则覆盖为服务端值且此后不再重复请求（会话内缓存只缓存成功）；
/// 失败保留占位常量但**不置位**——下次调用必须重试并能取到后来的成功值，防止一次瞬时故障
/// （含取消）把占位 URL 焊死进用户保存/转发的分享图（评审修复）。
/// 测试缝：`init(fetchConfig:)` 注入假闭包，不发真实网络请求（对齐 FavoritesStore/ViewTracker 写法）。
final class RemoteConfigTests: XCTestCase {
    private actor CallCounter {
        private(set) var count = 0
        func increment() { count += 1 }
    }

    @MainActor
    func testDefaultsToPlaceholderBeforeLoading() {
        let config = RemoteConfig(fetchConfig: { RemoteAppConfig(shareLandingUrl: "https://zx.example/x") })
        XCTAssertEqual(config.shareLandingUrl, RemoteConfig.placeholderShareLandingUrl)
    }

    @MainActor
    func testLoadSuccessOverwritesPlaceholder() async {
        let config = RemoteConfig(fetchConfig: { RemoteAppConfig(shareLandingUrl: "https://zx.example/beta") })

        await config.load()

        XCTAssertEqual(config.shareLandingUrl, "https://zx.example/beta")
    }

    @MainActor
    func testLoadFailureKeepsPlaceholder() async {
        struct Boom: Error {}
        let config = RemoteConfig(fetchConfig: { throw Boom() })

        await config.load()

        XCTAssertEqual(config.shareLandingUrl, RemoteConfig.placeholderShareLandingUrl)
    }

    /// 失败不得被缓存：首次失败（等价于瞬时网络故障或 sheet 秒关触发的取消）后再次 load()
    /// 必须真的重发请求，并把这次成功取到的服务端值写入——否则占位 URL 会被焊死整个会话，
    /// 烙进用户此后保存/转发的每一张分享图。
    @MainActor
    func testLoadRetriesAfterFailureAndAppliesLaterSuccess() async {
        struct Boom: Error {}
        let counter = CallCounter()
        let config = RemoteConfig(fetchConfig: {
            await counter.increment()
            if await counter.count == 1 { throw Boom() }
            return RemoteAppConfig(shareLandingUrl: "https://zx.example/beta")
        })

        await config.load()
        XCTAssertEqual(config.shareLandingUrl, RemoteConfig.placeholderShareLandingUrl, "首次失败回退占位")

        await config.load()

        let count = await counter.count
        XCTAssertEqual(count, 2, "失败后再次 load() 应重发请求，而不是命中缓存直接返回")
        XCTAssertEqual(config.shareLandingUrl, "https://zx.example/beta", "重试成功的服务端值应生效")
    }

    @MainActor
    func testSecondLoadDoesNotRefetchAfterSuccess() async {
        let counter = CallCounter()
        let config = RemoteConfig(fetchConfig: {
            await counter.increment()
            return RemoteAppConfig(shareLandingUrl: "https://zx.example/beta")
        })

        await config.load()
        await config.load()

        let count = await counter.count
        XCTAssertEqual(count, 1, "第二次调用应直接返回，不重复请求")
    }
}
