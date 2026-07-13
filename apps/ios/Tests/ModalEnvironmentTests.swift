import XCTest

/// Catalyst 环境注入回归测试（源码扫描 tripwire）。
///
/// 背景：Mac Catalyst 下 sheet/fullScreenCover 的宿主不继承 WindowGroup 注入的
/// 环境对象，模态根视图里 `@Environment(FootprintStore.self)` 会直接
/// "No Observable object" 崩溃退出。iOS 模拟器上环境继承正常，单测/模拟器
/// 走查都测不出来——所以只能在源码层面兜底：**每一处**模态入口的内容闭包
/// 都必须挂 `.appStores()` 重新注入（实现见 Core/AppStores.swift）。
///
/// 断言方式：逐文件统计非注释行里的模态修饰符（.sheet / .fullScreenCover /
/// .popover）出现次数，要求同文件 `.appStores()` 次数不少于它。计数是启发式
/// 而非语法分析，但足以让"新增 sheet 忘了注入"在 CI 上立刻爆红。
final class ModalEnvironmentTests: XCTestCase {
    private static let presentationMarkers = [".sheet(", ".fullScreenCover(", ".popover("]

    private func occurrences(of needle: String, in text: String) -> Int {
        var count = 0
        var searchRange = text.startIndex..<text.endIndex
        while let found = text.range(of: needle, range: searchRange) {
            count += 1
            searchRange = found.upperBound..<text.endIndex
        }
        return count
    }

    private func appSourceFiles() throws -> [URL] {
        // Tests/ 与 Zhixing/ 同级，用 #filePath 反推源码根目录
        let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourcesDir = testsDir.deletingLastPathComponent().appendingPathComponent("Zhixing")
        let enumerator = FileManager.default.enumerator(at: sourcesDir, includingPropertiesForKeys: nil)
        var files: [URL] = []
        while let url = enumerator?.nextObject() as? URL {
            if url.pathExtension == "swift" { files.append(url) }
        }
        XCTAssertFalse(files.isEmpty, "未找到 App 源码目录：\(sourcesDir.path)")
        return files
    }

    /// 每个含模态入口的源文件，.appStores() 出现次数必须 ≥ 模态修饰符出现次数。
    func testEveryModalRootReinjectsAppStores() throws {
        var violations: [String] = []
        for file in try appSourceFiles() {
            let source = try String(contentsOf: file, encoding: .utf8)
            var presentations = 0
            var injections = 0
            for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") { continue } // 注释里的示意（如 .sheet(item:)）不计数
                for marker in Self.presentationMarkers {
                    presentations += occurrences(of: marker, in: trimmed)
                }
                injections += occurrences(of: ".appStores()", in: trimmed)
            }
            if presentations > injections {
                violations.append("\(file.lastPathComponent)：\(presentations) 处模态入口，仅 \(injections) 处 .appStores()")
            }
        }
        XCTAssertTrue(violations.isEmpty, """
            以下文件存在未重新注入环境对象的模态入口，会在 Mac Catalyst 上崩溃 \
            （在 sheet/fullScreenCover 内容闭包末尾补 .appStores()）：
            \(violations.joined(separator: "\n"))
            """)
    }

    /// WindowGroup 根视图也必须走同一 .appStores()——否则主界面与 sheet 拿到的是两批实例，
    /// 崩溃虽消失，数据却会静默不同步（更难查）。
    func testRootViewUsesSameStoreInstances() throws {
        let appFile = try XCTUnwrap(
            try appSourceFiles().first { $0.lastPathComponent == "ZhixingApp.swift" })
        let source = try String(contentsOf: appFile, encoding: .utf8)
        XCTAssertTrue(source.contains(".appStores()"),
                      "ZhixingApp 根视图必须用 .appStores() 注入，保证与模态视图共享同一批 store 实例")
    }
}
