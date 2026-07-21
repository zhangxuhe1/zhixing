import Foundation
import os

protocol SessionTokenStore {
    func load() throws -> String?
    func save(_ token: String) throws
    func delete() throws
}

/// 把系统 Keychain 包装成可注入的 `SessionTokenStore`，让 Catalyst 的降级与迁移状态机
/// 能用内存 fake 做平台无关单测，而不需要在测试进程中伪造 Security.framework。
struct KeychainSessionTokenStore: SessionTokenStore {
    func load() throws -> String? { try Keychain.load(key: "token") }
    func save(_ token: String) throws { try Keychain.save(token, key: "token") }
    func delete() throws { try Keychain.delete(key: "token") }
}

/// 主存储不可用时使用降级存储，并在主存储恢复后自动迁移。
///
/// `isPrimaryUnavailable` 只应匹配“这个平台确实无法使用主存储”的错误；其他错误继续上抛，
/// 避免把真正的 Keychain 故障悄悄降级成明文文件。
struct FallbackSessionTokenStore: SessionTokenStore {
    private static let logger = Logger(subsystem: "app.zhixing.ios", category: "SessionPersistence")
    private let primary: any SessionTokenStore
    private let fallback: any SessionTokenStore
    private let isPrimaryUnavailable: (Error) -> Bool

    init(
        primary: any SessionTokenStore,
        fallback: any SessionTokenStore,
        isPrimaryUnavailable: @escaping (Error) -> Bool
    ) {
        self.primary = primary
        self.fallback = fallback
        self.isPrimaryUnavailable = isPrimaryUnavailable
    }

    func load() throws -> String? {
        do {
            if let token = try primary.load() {
                try reconcileFallback(with: token, context: "主存储可用")
                return token
            }
        } catch where isPrimaryUnavailable(error) {
            return try fallback.load()
        }

        guard let token = try fallback.load() else { return nil }
        do {
            try primary.save(token)
        } catch where isPrimaryUnavailable(error) {
            // ad-hoc Catalyst 的预期路径：继续使用已经验证可读的文件 token。
            return token
        } catch {
            // 主存储写入失败但非 entitlement 缺失：保留可读的文件会话，下次启动再迁。
            Self.logger.warning("会话暂未迁回主存储：\(error.localizedDescription, privacy: .public)")
            return token
        }
        // primary 已持有同一 token 后，必须完成降级侧协调；失败应上抛，与主路径/save 一致。
        try reconcileFallback(with: token, context: "迁移完成")
        return token
    }

    func save(_ token: String) throws {
        do {
            try primary.save(token)
            try reconcileFallback(with: token, context: "主存储保存成功")
        } catch where isPrimaryUnavailable(error) {
            try fallback.save(token)
        }
    }

    func delete() throws {
        var firstError: Error?
        do {
            try primary.delete()
        } catch where isPrimaryUnavailable(error) {
            // ad-hoc Catalyst 的预期路径，仍须继续删除文件降级会话。
        } catch {
            firstError = error
        }

        do {
            try fallback.delete()
        } catch {
            if firstError == nil { firstError = error }
        }
        if let firstError { throw firstError }
    }

    /// 主存储已有权威 token 后，降级存储只能处于两种安全状态：不存在，或保存同一 token。
    ///
    /// 删除失败时改为同步当前 token，避免将来主存储不可用时恢复出旧账号。删除和同步都失败时：
    /// - 若降级侧**已经**是同一 token，内容一致，允许继续（仍会打日志，下次启动再试清理）；
    /// - 若仍是旧/不同 token，则上抛，让当前登录/恢复失败关闭。
    ///
    /// 已知残留：写权限全失且内容不一致时，本次调用 fail-closed，但旧降级文件仍可能留在磁盘；
    /// 若之后主存储再次不可用，`load` 的降级分支仍可能读到旧账号。该状态只能靠后续一次成功的
    /// 删除或同步消除，无法在只读故障下单方面修好。
    private func reconcileFallback(with token: String, context: String) throws {
        do {
            try fallback.delete()
        } catch let deleteError {
            Self.logger.warning(
                "\(context, privacy: .public)，但降级会话清理失败，改为同步当前会话：\(deleteError.localizedDescription, privacy: .public)")
            do {
                try fallback.save(token)
                Self.logger.notice("降级会话已与主存储同步；下次启动将继续尝试清理")
            } catch {
                if (try? fallback.load()) == token {
                    Self.logger.warning(
                        "\(context, privacy: .public)，降级会话无法清理/覆写，但已与主存储内容一致")
                    return
                }
                Self.logger.fault(
                    "降级会话既无法清理也无法同步，且仍与主存储不一致：\(error.localizedDescription, privacy: .public)")
                throw error
            }
        }
    }
}

/// `SessionStore` 的生产存储。
///
/// iOS 始终只使用 Keychain。无 Team、ad-hoc 签名的 Mac Catalyst 产物没有
/// application-identifier，Data Protection Keychain 会稳定返回 -34018；该场景临时降级到
/// Application Support 的 0600 文件。以后换成合法稳定签名后，首次启动会自动把旧文件迁回
/// Keychain 并删除文件。
struct DefaultSessionTokenStore: SessionTokenStore {
    private let store: any SessionTokenStore

    init(fallbackDirectory: URL? = nil) {
        let keychain = KeychainSessionTokenStore()
        #if targetEnvironment(macCatalyst)
        store = FallbackSessionTokenStore(
            primary: keychain,
            fallback: FileSessionTokenStore(directory: fallbackDirectory),
            isPrimaryUnavailable: { error in
                guard let error = error as? SessionPersistenceError else { return false }
                return error.isMissingEntitlement
            })
        #else
        store = keychain
        #endif
    }

    func load() throws -> String? { try store.load() }
    func save(_ token: String) throws {
        guard !token.isEmpty else { throw SessionPersistenceError.emptyToken }
        try store.save(token)
    }
    func delete() throws { try store.delete() }
}

/// 无开发者账号的 Catalyst 内测期兼容层。Bearer token 没有写入 UserDefaults；文件和父目录分别
/// 收紧为 0600/0700，并排除备份。它依赖当前 macOS 用户账户的文件隔离，安全性仍低于 Keychain，
/// 获得正式签名后由 `DefaultSessionTokenStore` 自动迁移并删除。
struct FileSessionTokenStore: SessionTokenStore {
    private static let logger = Logger(subsystem: "app.zhixing.ios", category: "SessionPersistence")

    #if DEBUG
    static let defaultFilename = "session-debug-v1.jwt"
    #else
    static let defaultFilename = "session-v1.jwt"
    #endif

    private let directoryOverride: URL?
    private let fileManager: FileManager
    private let filename: String
    private let finalizeStagedFile: (URL) throws -> Void

    init(
        directory: URL? = nil,
        fileManager: FileManager = .default,
        filename: String = FileSessionTokenStore.defaultFilename,
        finalizeStagedFile: ((URL) throws -> Void)? = nil
    ) {
        directoryOverride = directory
        self.fileManager = fileManager
        self.filename = filename
        self.finalizeStagedFile = finalizeStagedFile ?? { url in
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o600)],
                ofItemAtPath: url.path)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableURL = url
            try mutableURL.setResourceValues(values)
        }
    }

    private var directory: URL {
        if let directoryOverride { return directoryOverride }
        return fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("app.zhixing.ios", isDirectory: true)
    }

    /// Debug 本地 API 与 Release 生产 API 的 JWT 密钥不同，必须分文件，避免开发登录污染安装版会话。
    var fileURL: URL { directory.appendingPathComponent(filename, isDirectory: false) }

    func load() throws -> String? {
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }
        do {
            let token = String(decoding: try Data(contentsOf: fileURL), as: UTF8.self)
            guard !token.isEmpty else { throw SessionPersistenceError.emptyToken }
            return token
        } catch let error as SessionPersistenceError {
            throw error
        } catch {
            throw SessionPersistenceError.file(operation: "读取", underlying: error)
        }
    }

    func save(_ token: String) throws {
        guard !token.isEmpty else { throw SessionPersistenceError.emptyToken }
        let stagedURL = directory.appendingPathComponent(
            ".\(filename).\(UUID().uuidString).tmp", isDirectory: false)
        do {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: 0o700)])
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o700)],
                ofItemAtPath: directory.path)
            try Data(token.utf8).write(to: stagedURL, options: .atomic)
            try finalizeStagedFile(stagedURL)

            if fileManager.fileExists(atPath: fileURL.path) {
                _ = try fileManager.replaceItemAt(
                    fileURL,
                    withItemAt: stagedURL,
                    backupItemName: nil,
                    options: [.usingNewMetadataOnly])
            } else {
                try fileManager.moveItem(at: stagedURL, to: fileURL)
            }
        } catch {
            if fileManager.fileExists(atPath: stagedURL.path) {
                do { try fileManager.removeItem(at: stagedURL) }
                catch {
                    Self.logger.error("清理会话临时文件失败：\(error.localizedDescription, privacy: .public)")
                }
            }
            throw SessionPersistenceError.file(operation: "保存", underlying: error)
        }
    }

    func delete() throws {
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        do {
            try fileManager.removeItem(at: fileURL)
        } catch {
            throw SessionPersistenceError.file(operation: "删除", underlying: error)
        }
    }
}
