import Foundation

enum AppConfig {
    /// Debug 指向本机 API（模拟器可直连 localhost），Release 由 project.yml 注入正式域名
    static var apiBase: URL {
        let raw = Bundle.main.object(forInfoDictionaryKey: "APIBase") as? String
        return URL(string: raw ?? "http://localhost:8787")!
    }
}
