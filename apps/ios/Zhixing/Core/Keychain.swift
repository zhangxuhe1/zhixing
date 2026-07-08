import Foundation
import os
import Security

enum Keychain {
    private static let logger = Logger(subsystem: "app.zhixing.ios", category: "Keychain")

    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "app.zhixing.session",
         kSecAttrAccount as String: key]
    }

    /// 先删后加保证幂等覆盖；SecItemAdd 非 success（例如遗留脏项恰好没被上面的 delete 清掉）时
    /// 再删一次重试一遍——多数情况下这就能自愈。两次都不成功就 os_log fault 留痕（调用方 SessionStore
    /// 目前不感知 save 失败，至少不能悄无声息：不这样做的话，登录态本该落盘却没落盘，会在下次冷启动
    /// 时表现成"莫名其妙被登出"，且完全没有线索）。
    static func save(_ value: String, key: String) {
        SecItemDelete(query(key) as CFDictionary)
        var attrs = query(key)
        attrs[kSecValueData as String] = Data(value.utf8)
        var status = SecItemAdd(attrs as CFDictionary, nil)
        if status != errSecSuccess {
            logger.fault("Keychain save 首次失败 status=\(status, privacy: .public)，删除后重试一次")
            SecItemDelete(query(key) as CFDictionary)
            status = SecItemAdd(attrs as CFDictionary, nil)
            if status != errSecSuccess {
                logger.fault("Keychain save 重试后仍失败 status=\(status, privacy: .public)")
            }
        }
    }

    static func load(key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// errSecItemNotFound 是正常态（本来就没有 / 已经删过），不算失败；其余非 success 才记 fault。
    static func delete(key: String) {
        let status = SecItemDelete(query(key) as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            logger.fault("Keychain delete 失败 status=\(status, privacy: .public)")
        }
    }
}
