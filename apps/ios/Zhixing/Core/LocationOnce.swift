import CoreLocation

enum LocationError: Error {
    case denied
    case timeout
}

/// 一次性 whenInUse 定位（供撰写器「使用当前位置」选点使用）。
/// 已授权：直接取一次定位；未决：先请求授权，用户响应后再取；拒绝/受限：LocationError.denied；
/// 10 秒未产出结果（含底层出错，权限被收回除外）统一 LocationError.timeout——调用方按「拒绝引导去设置/
/// 其余失败可重试」两路处理，不需要更细的错误分类。
enum LocationOnce {
    @MainActor
    static func current() async throws -> CLLocationCoordinate2D {
        try await withCheckedThrowingContinuation { continuation in
            LocationOnceRequest(continuation: continuation).start()
        }
    }
}

@MainActor
private final class LocationOnceRequest: NSObject, @preconcurrency CLLocationManagerDelegate {
    /// CLLocationManager.delegate 是 weak——没有别处强引用时 self 会在等待期间被提前释放，
    /// 用静态数组自持一份，finish 时移除；支持多个请求并发（虽然按钮会 disable 防连点）。
    private static var inFlight: [LocationOnceRequest] = []

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocationCoordinate2D, Error>?
    private var timeoutTask: Task<Void, Never>?

    init(continuation: CheckedContinuation<CLLocationCoordinate2D, Error>) {
        self.continuation = continuation
    }

    func start() {
        Self.inFlight.append(self)
        manager.delegate = self
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            self?.finish(.failure(LocationError.timeout))
        }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            finish(.failure(LocationError.denied))
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        default:
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        case .denied, .restricted:
            finish(.failure(LocationError.denied))
        default:
            break // notDetermined：还在等用户响应系统弹窗
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let coordinate = locations.last?.coordinate else { return }
        finish(.success(coordinate))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // 权限中途被收回也会走这里报 CLError.denied——按拒绝处理而非笼统超时，文案才对得上。
        if let clError = error as? CLError, clError.code == .denied {
            finish(.failure(LocationError.denied))
        } else {
            finish(.failure(LocationError.timeout))
        }
    }

    /// 只在第一次调用生效：continuation 置 nil 后，授权回调/didFail/超时里晚到的任何一路都安全忽略。
    private func finish(_ result: Result<CLLocationCoordinate2D, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        Self.inFlight.removeAll { $0 === self }
        continuation.resume(with: result)
    }
}
