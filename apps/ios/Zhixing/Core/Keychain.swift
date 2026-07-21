import Foundation
import os
import Security

enum SessionPersistenceError: Error, LocalizedError {
    case keychain(operation: String, status: OSStatus)
    case file(operation: String, underlying: Error)
    case emptyToken

    var isMissingEntitlement: Bool {
        if case let .keychain(_, status) = self { return status == errSecMissingEntitlement }
        return false
    }

    var errorDescription: String? {
        switch self {
        case let .keychain(operation, status):
            return "会话钥匙串\(operation)失败（\(status)）"
        case let .file(operation, underlying):
            return "会话文件\(operation)失败：\(underlying.localizedDescription)"
        case .emptyToken:
            return "保存的会话为空"
        }
    }
}

enum Keychain {
    private static let logger = Logger(subsystem: "app.zhixing.ios", category: "Keychain")

    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "app.zhixing.session",
         kSecAttrAccount as String: key]
    }

    /// 优先原位更新，避免“先删旧 token、再写新 token”在第二步失败时丢失原会话。
    /// 保存失败必须上抛，调用方不能继续制造“本次已登录、冷启动又掉线”的假成功。
    static func save(_ value: String, key: String) throws {
        let data = Data(value.utf8)
        let updateStatus = SecItemUpdate(
            query(key) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            logger.error("Keychain update 失败 status=\(updateStatus, privacy: .public)")
            throw SessionPersistenceError.keychain(operation: "更新", status: updateStatus)
        }

        var attrs = query(key)
        attrs[kSecValueData as String] = data
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            logger.error("Keychain save 失败 status=\(status, privacy: .public)")
            throw SessionPersistenceError.keychain(operation: "保存", status: status)
        }
    }

    static func load(key: String) throws -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else {
            logger.error("Keychain load 失败 status=\(status, privacy: .public)")
            throw SessionPersistenceError.keychain(operation: "读取", status: status)
        }
        let token = String(decoding: data, as: UTF8.self)
        guard !token.isEmpty else { throw SessionPersistenceError.emptyToken }
        return token
    }

    /// errSecItemNotFound 是正常态；其余错误上抛给会话存储层统一处理。
    static func delete(key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            logger.error("Keychain delete 失败 status=\(status, privacy: .public)")
            throw SessionPersistenceError.keychain(operation: "删除", status: status)
        }
    }
}
