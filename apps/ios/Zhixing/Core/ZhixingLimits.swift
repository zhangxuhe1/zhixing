/// 产品数值上限(单源;api 侧对应 photos.ts 的 FOOTPRINT_PHOTO_LIMIT,双端无法共享需人工对齐)。
enum ZXLimit {
    /// 单条足迹照片上限(2026-07-18 走查放宽 9→12)。
    static let footprintPhotos = 12
}
