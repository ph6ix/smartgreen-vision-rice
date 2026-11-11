/**
 * ผลิตภัณฑ์สมาร์ทกรีนที่อนุญาตให้ AI แนะนำในแอปตรวจใบข้าว
 *
 * - ตอนนี้ยังว่างอยู่: รอฝ่ายวิชาการยืนยันรายการสำหรับข้าว AI จึงจะไม่แนะนำสินค้า
 * - AI จะแนะนำได้ "เฉพาะ" รายการที่ enabled: true เท่านั้น (ชื่อที่ไม่อยู่ในรายการจะถูกตัดทิ้งฝั่งเซิร์ฟเวอร์)
 * - เพิ่มสินค้าได้ที่ไฟล์นี้ไฟล์เดียว ตามรูปแบบตัวอย่างด้านล่าง แล้ววางรูปสินค้าไว้ใน public/assets/
 * - อัตราใช้ให้ระบุใน `usage` ถ้าไม่ระบุ AI จะบอกให้ "ใช้ตามอัตราบนฉลาก"
 *
 * ตัวอย่าง:
 *   {
 *     key: 'takecare',
 *     name: 'เทคแคร์ เม็ด (50 กก.)',
 *     image: '/assets/take_care_bag.png',
 *     fixes: ['Mg', 'ดินกรด'],
 *     description: 'มีแคลเซียม แมกนีเซียม ซิลิคอน ปรับปรุงดินกรด',
 *     usage: '',
 *     enabled: true,
 *   },
 */
export const RICE_PRODUCTS = [];

export function getEnabledRiceProducts() {
  return RICE_PRODUCTS.filter(p => p.enabled);
}

/** Find an enabled product by (fuzzy) name, or null if it is not on the approved list. */
export function matchRiceProduct(name) {
  if (!name) return null;
  const norm = (s) => String(s).replace(/\s+/g, '').replace(/\(.*?\)/g, '').toLowerCase();
  const n = norm(name);
  if (n.length < 3) return null;
  return getEnabledRiceProducts().find(p => {
    const pn = norm(p.name);
    return n.includes(pn) || pn.includes(n);
  }) || null;
}
