import XCTest
import Security
@testable import Zhixing

final class InMemorySessionTokenStore: SessionTokenStore {
    var token: String?
    var loadError: Error?
    var saveError: Error?
    var deleteError: Error?
    private(set) var loadCallCount = 0
    private(set) var savedTokens: [String] = []
    private(set) var deleteCallCount = 0

    init(token: String? = nil) {
        self.token = token
    }

    func load() throws -> String? {
        loadCallCount += 1
        if let loadError { throw loadError }
        return token
    }

    func save(_ token: String) throws {
        savedTokens.append(token)
        if let saveError { throw saveError }
        self.token = token
    }

    func delete() throws {
        deleteCallCount += 1
        if let deleteError { throw deleteError }
        token = nil
    }
}

final class SessionTokenStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhixing-session-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let directory, FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        directory = nil
        try super.tearDownWithError()
    }

    func testFileStoreRoundTripAndDelete() throws {
        let store = FileSessionTokenStore(directory: directory)
        XCTAssertNil(try store.load())

        try store.save("jwt-round-trip")
        XCTAssertEqual(try store.load(), "jwt-round-trip")

        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue & 0o777, 0o600)
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        let directoryPermissions = try XCTUnwrap(directoryAttributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(directoryPermissions.intValue & 0o777, 0o700)
        let resourceValues = try store.fileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(resourceValues.isExcludedFromBackup, true)

        try store.delete()
        XCTAssertNil(try store.load())
    }

    func testFileStoreOverwriteIsAtomicAndKeepsPermissions() throws {
        let store = FileSessionTokenStore(directory: directory)
        try store.save("old-token")
        try store.save("new-token")

        XCTAssertEqual(try store.load(), "new-token")
        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue & 0o777, 0o600)
    }

    func testFileStoreRejectsEmptyToken() {
        let store = FileSessionTokenStore(directory: directory)
        XCTAssertThrowsError(try store.save("")) { error in
            guard case SessionPersistenceError.emptyToken = error else {
                return XCTFail("错误类型不符：\(error)")
            }
        }
    }

    func testFileStoreFailedFinalizeLeavesExistingTokenUntouched() throws {
        let healthyStore = FileSessionTokenStore(directory: directory)
        try healthyStore.save("old-token")
        let failingStore = FileSessionTokenStore(
            directory: directory,
            finalizeStagedFile: { _ in throw CocoaError(.fileWriteNoPermission) })

        XCTAssertThrowsError(try failingStore.save("new-token"))
        XCTAssertEqual(try healthyStore.load(), "old-token")

        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(names, [FileSessionTokenStore.defaultFilename])
    }

    func testFileStoreFailedFinalizeDoesNotLeaveNewSession() throws {
        let store = FileSessionTokenStore(
            directory: directory,
            finalizeStagedFile: { _ in throw CocoaError(.fileWriteNoPermission) })

        XCTAssertThrowsError(try store.save("jwt-must-not-survive"))
        XCTAssertNil(try store.load())
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testFallbackStoreUsesFileWhenPrimaryIsUnavailable() throws {
        let unavailable = SessionPersistenceError.keychain(
            operation: "测试", status: errSecMissingEntitlement)
        let primary = InMemorySessionTokenStore()
        primary.loadError = unavailable
        primary.saveError = unavailable
        primary.deleteError = unavailable
        let fallback = InMemorySessionTokenStore(token: "file-token")
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertEqual(try store.load(), "file-token")
        try store.save("new-file-token")
        XCTAssertEqual(fallback.token, "new-file-token")
        try store.delete()
        XCTAssertNil(fallback.token)
    }

    func testFallbackStoreMigratesFileTokenWhenPrimaryRecovers() throws {
        let primary = InMemorySessionTokenStore()
        let fallback = InMemorySessionTokenStore(token: "file-token")
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertEqual(try store.load(), "file-token")
        XCTAssertEqual(primary.token, "file-token")
        XCTAssertNil(fallback.token)
        XCTAssertEqual(primary.savedTokens, ["file-token"])
        XCTAssertEqual(fallback.deleteCallCount, 1)
    }

    func testFallbackStorePrefersPrimaryAndCleansStaleFile() throws {
        let primary = InMemorySessionTokenStore(token: "keychain-token")
        let fallback = InMemorySessionTokenStore(token: "stale-file-token")
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertEqual(try store.load(), "keychain-token")
        XCTAssertNil(fallback.token)
        XCTAssertEqual(fallback.loadCallCount, 0)
    }

    func testFallbackStoreSynchronizesStaleFileWhenCleanupFails() throws {
        let unavailable = SessionPersistenceError.keychain(
            operation: "测试", status: errSecMissingEntitlement)
        let primary = InMemorySessionTokenStore(token: "current-keychain-token")
        let fallback = InMemorySessionTokenStore(token: "stale-file-token")
        fallback.deleteError = CocoaError(.fileWriteNoPermission)
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertEqual(try store.load(), "current-keychain-token")
        XCTAssertEqual(fallback.token, "current-keychain-token")
        XCTAssertEqual(fallback.savedTokens, ["current-keychain-token"])

        // 模拟下一版签名变化导致 Keychain 再次不可用；此时不得恢复出旧文件账号。
        primary.loadError = unavailable
        XCTAssertEqual(try store.load(), "current-keychain-token")
    }

    func testFallbackStoreSaveSynchronizesStaleFileWhenCleanupFails() throws {
        let unavailable = SessionPersistenceError.keychain(
            operation: "测试", status: errSecMissingEntitlement)
        let primary = InMemorySessionTokenStore(token: "old-keychain-token")
        let fallback = InMemorySessionTokenStore(token: "stale-file-token")
        fallback.deleteError = CocoaError(.fileWriteNoPermission)
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        try store.save("new-token")

        XCTAssertEqual(primary.token, "new-token")
        XCTAssertEqual(fallback.token, "new-token")
        XCTAssertEqual(fallback.savedTokens, ["new-token"])

        // 与读取路径一致：同步成功后，主存储再次不可用也不得恢复旧文件账号。
        primary.loadError = unavailable
        XCTAssertEqual(try store.load(), "new-token")
    }

    func testFallbackStoreFailsClosedWhenCleanupAndSynchronizationBothFail() throws {
        let unavailable = SessionPersistenceError.keychain(
            operation: "测试", status: errSecMissingEntitlement)
        let primary = InMemorySessionTokenStore(token: "current-keychain-token")
        let fallback = InMemorySessionTokenStore(token: "stale-file-token")
        fallback.deleteError = CocoaError(.fileWriteNoPermission)
        fallback.saveError = CocoaError(.fileWriteVolumeReadOnly)
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertThrowsError(try store.load())
        XCTAssertEqual(fallback.token, "stale-file-token")
        XCTAssertEqual(fallback.savedTokens, ["current-keychain-token"])

        // 已知残留：当前调用已失败关闭，但旧降级文件仍在；主存储再次不可用时仍可能读到旧账号。
        // 写权限全失时无法单方面消除，只能靠后续一次成功的删除/同步。
        primary.loadError = unavailable
        XCTAssertEqual(try store.load(), "stale-file-token")
    }

    func testFallbackStoreAllowsConsistentFallbackWhenCleanupAndSyncBothFail() throws {
        let primary = InMemorySessionTokenStore(token: "same-token")
        let fallback = InMemorySessionTokenStore(token: "same-token")
        fallback.deleteError = CocoaError(.fileWriteNoPermission)
        fallback.saveError = CocoaError(.fileWriteVolumeReadOnly)
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertEqual(try store.load(), "same-token")
        XCTAssertEqual(fallback.token, "same-token")
    }

    func testFallbackStoreMigrationSucceedsWhenFallbackAlreadyMatchesAfterFailedCleanup() throws {
        let primary = InMemorySessionTokenStore()
        let fallback = InMemorySessionTokenStore(token: "file-token")
        fallback.deleteError = CocoaError(.fileWriteNoPermission)
        fallback.saveError = CocoaError(.fileWriteVolumeReadOnly)
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        // primary.save 成功后 delete/save 都失败，但 fallback 仍是同一 file-token → 内容一致，应放行。
        XCTAssertEqual(try store.load(), "file-token")
        XCTAssertEqual(primary.token, "file-token")
        XCTAssertEqual(fallback.token, "file-token")
    }

    func testFallbackStoreDeleteAttemptsBothStoresAndPropagatesFailure() {
        let primary = InMemorySessionTokenStore(token: "keychain-token")
        let fallback = InMemorySessionTokenStore(token: "file-token")
        fallback.deleteError = CocoaError(.fileWriteNoPermission)
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertThrowsError(try store.delete())
        XCTAssertNil(primary.token)
        XCTAssertEqual(fallback.token, "file-token")
        XCTAssertEqual(primary.deleteCallCount, 1)
        XCTAssertEqual(fallback.deleteCallCount, 1)
    }

    func testFallbackStoreDoesNotDowngradeForUnrelatedPrimaryFailure() {
        let primary = InMemorySessionTokenStore()
        primary.saveError = CocoaError(.fileWriteUnknown)
        let fallback = InMemorySessionTokenStore()
        let store = makeFallbackStore(primary: primary, fallback: fallback)

        XCTAssertThrowsError(try store.save("must-not-be-written-in-plaintext"))
        XCTAssertNil(fallback.token)
        XCTAssertEqual(fallback.savedTokens, [])
    }

    private func makeFallbackStore(
        primary: InMemorySessionTokenStore,
        fallback: InMemorySessionTokenStore
    ) -> FallbackSessionTokenStore {
        FallbackSessionTokenStore(
            primary: primary,
            fallback: fallback,
            isPrimaryUnavailable: { error in
                guard let error = error as? SessionPersistenceError else { return false }
                return error.isMissingEntitlement
            })
    }
}
