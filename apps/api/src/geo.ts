/** 球面两点距离(米)——与 iOS GeoMatch.swift 的 haversineMeters 同式,服务端父级自动猜用。 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
