import Foundation

enum AppConfig {
    /// Debug 指向本机 API（模拟器可直连 localhost），Release 由 project.yml 注入正式域名
    static var apiBase: URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "APIBase") as? String) ?? ""
        if !raw.isEmpty, let url = URL(string: raw) { return url }
        #if DEBUG
        return URL(string: "http://localhost:8787")!
        #else
        preconditionFailure("APIBase 未配置或非法——检查 project.yml 的 APP_API_BASE")
        #endif
    }
}
