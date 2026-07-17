import XCTest
@testable import Zhixing

/// 看图页邻页预载加载器(spec:2026-07-17-photo-browser-preload-design.md):
/// 窗口纯函数、只拉窗口内缺失项、在途去重、窗口滑动淘汰、失败进 failed、retry 重拉。
final class BrowserPhotoLoaderTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // loader 会查/写全局缓存,逐用例清空保证隔离
        ZXPhotoMemoryCache.shared.removeAll()
    }

    /// 记录 fetch 调用的线程安全日志;可按 id 定制失败。
    private actor FetchLog {
        private(set) var ids: [String] = []
        private(set) var failingIds: Set<String> = []
        func record(_ id: String) { ids.append(id) }
        func setFailing(_ ids: Set<String>) { failingIds = ids }
    }

    /// 4×4 红色 PNG:足够小、可被 downsampledImage 解码。
    private static let tinyPNG: Data = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
        .pngData { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }

    private static func ids(_ n: Int) -> [String] { (0..<n).map { "p\($0)" } }

    @MainActor
    private func waitUntil(
        _ what: String, timeoutMs: Int = 2000, _ condition: () -> Bool
    ) async {
        for _ in 0..<(timeoutMs / 10) {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("等待超时:\(what)")
    }

    @MainActor
    private func makeLoader(
        count: Int, log: FetchLog, delayMs: Int = 0
    ) -> ZXBrowserPhotoLoader {
        ZXBrowserPhotoLoader(
            photoIds: Self.ids(count),
            fetch: { id in
                await log.record(id)
                if delayMs > 0 { try? await Task.sleep(for: .milliseconds(delayMs)) }
                if await log.failingIds.contains(id) { throw URLError(.timedOut) }
                return Self.tinyPNG
            },
            maxPixelSize: 64)
    }

    func testPrefetchWindowOrdersNeighborsByPriority() {
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 5, count: 12), [5, 6, 4, 7, 3])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 0, count: 12), [0, 1, 2])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 11, count: 12), [11, 10, 9])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 1, count: 3), [1, 2, 0])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 0, count: 1), [0])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 9, count: 0), [])
        // 越界 index 先夹回合法区间再展开窗口
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 99, count: 3), [2, 1, 0])
    }

    @MainActor
    func testFocusLoadsOnlyWindowAndDedupesInflight() async {
        let log = FetchLog()
        let loader = makeLoader(count: 12, log: log, delayMs: 50)
        loader.focus(5)
        loader.focus(5) // 在途去重:第二次 focus 不得重复起拉
        await waitUntil("窗口 5 张就位") { loader.images.count == 5 }
        let fetched = await log.ids
        XCTAssertEqual(Set(fetched), Set(["p3", "p4", "p5", "p6", "p7"]))
        XCTAssertEqual(fetched.count, 5)
        XCTAssertEqual(Set(loader.images.keys), Set(["p3", "p4", "p5", "p6", "p7"]))
        XCTAssertTrue(loader.failed.isEmpty)
    }

    @MainActor
    func testWindowSlideEvictsOutOfWindowImages() async {
        let log = FetchLog()
        let loader = makeLoader(count: 12, log: log)
        loader.focus(0)
        await waitUntil("首窗就位") { loader.images.count == 3 }
        loader.focus(8)
        await waitUntil("新窗就位") { Set(loader.images.keys) == Set(["p6", "p7", "p8", "p9", "p10"]) }
        XCTAssertNil(loader.images["p0"]) // 滑窗后旧页必须淘汰,缓存上限=窗口
    }

    @MainActor
    func testFailureMarksFailedAndRetryRecovers() async {
        let log = FetchLog()
        await log.setFailing(["p1"])
        let loader = makeLoader(count: 3, log: log)
        loader.focus(0)
        await waitUntil("失败页记入 failed") { loader.failed.contains("p1") }
        XCTAssertNil(loader.images["p1"])
        XCTAssertNotNil(loader.images["p0"]) // 单张失败不拖累邻页
        await log.setFailing([])
        loader.retry("p1")
        await waitUntil("retry 后恢复") { loader.images["p1"] != nil }
        XCTAssertFalse(loader.failed.contains("p1"))
    }

    /// 首帧契约:构造时就得把起始窗口的缓存图同步种进 images——focus 挂在 .task,
    /// 要等视图出现后才跑,首帧若查不到图,看图页打开仍旧黑底占位一闪(用户实测打回)。
    @MainActor
    func testInitSeedsStartWindowFromCacheSynchronously() {
        let cachedImage = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
            .image { ctx in
                UIColor.green.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
            }
        for id in ["p4", "p5", "p6"] { ZXPhotoMemoryCache.shared.insert(cachedImage, for: id) }
        let loader = ZXBrowserPhotoLoader(
            photoIds: Self.ids(12), startIndex: 5,
            fetch: { _ in Self.tinyPNG }, maxPixelSize: 64)
        // 不 focus、不等待:init 返回时窗口内已缓存的图必须已就位
        XCTAssertNotNil(loader.images["p5"])
        XCTAssertNotNil(loader.images["p4"])
        XCTAssertNotNil(loader.images["p6"])
        XCTAssertNil(loader.images["p0"]) // 窗口外不种
    }

    /// 全局缓存命中必须零网络短路(宫格看过的照片点开全屏即现,首开黑闪的根治路径)。
    @MainActor
    func testCacheHitShortCircuitsFetch() async {
        let log = FetchLog()
        let cachedImage = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
            .image { ctx in
                UIColor.blue.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
            }
        for id in ["p0", "p1", "p2"] { ZXPhotoMemoryCache.shared.insert(cachedImage, for: id) }
        let loader = makeLoader(count: 3, log: log)
        loader.focus(0)
        await waitUntil("缓存命中就位") { loader.images.count == 3 }
        let fetched = await log.ids
        XCTAssertTrue(fetched.isEmpty) // 全命中 → 零网络
    }

    @MainActor
    func testUndecodableBytesMarkFailed() async {
        let loader = ZXBrowserPhotoLoader(
            photoIds: Self.ids(1),
            fetch: { _ in Data([0x00, 0x01]) }, // 解不出图的字节
            maxPixelSize: 64)
        loader.focus(0)
        await waitUntil("坏字节进 failed") { loader.failed.contains("p0") }
    }
}
