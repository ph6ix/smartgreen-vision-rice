/**
 * Rice Leaf Doctor — AI analysis service
 * วิเคราะห์ธาตุอาหาร โรค และแมลงศัตรูข้าวจากภาพใบและต้น
 *
 * ความรู้อ้างอิงในคำสั่ง AI ด้านล่างเป็น "ร่าง" จากหลักวิชาการทั่วไป
 * ต้องให้ทีมนักวิชาการสมาร์ทกรีนตรวจทานก่อนใช้งานจริง
 */
import { isBusyError, BUSY_MESSAGE_TH } from './modelRetry.js';
import { generateJsonWithFallback, normalizeSmartGreenProductText } from './gemini.js';
import { getEnabledRiceProducts, matchRiceProduct } from './riceProducts.js';

// ตำแหน่งภาพที่รับ (3 ภาพบังคับ + 1 ภาพเสริม)
export const RICE_IMAGE_SLOTS = [
  { key: 'young', label: 'ใบอ่อน / ใบยอด (ใบที่เพิ่งแทงออกจากกาบ)', required: true },
  { key: 'mature', label: 'ใบมาตรฐาน (ใบที่คลี่เต็มที่ใบบนสุด — ใบที่ใช้เทียบแถบสีใบ LCC / ใบธงช่วงออกรวง)', required: true },
  { key: 'old', label: 'ใบล่าง / ใบแก่', required: true },
  { key: 'tree', label: 'กอข้าว / รวง / โคนกอ (ไม่บังคับ)', required: false },
];

export const RICE_NUTRIENTS = [
  { code: 'N', name: 'ไนโตรเจน (N)' },
  { code: 'P', name: 'ฟอสฟอรัส (P)' },
  { code: 'K', name: 'โพแทสเซียม (K)' },
  { code: 'Mg', name: 'แมกนีเซียม (Mg)' },
  { code: 'S', name: 'กำมะถัน (S)' },
  { code: 'Zn', name: 'สังกะสี (Zn)' },
  { code: 'Si', name: 'ซิลิคอน (Si)' },
  { code: 'Fe', name: 'เหล็ก (Fe)' },
];

const STATUS_LEVELS = ['ปกติ', 'เสี่ยงขาด', 'ขาดเล็กน้อย', 'ขาดปานกลาง', 'ขาดรุนแรง', 'ต้องตรวจเพิ่ม'];
const LIKELIHOODS = ['สูง', 'ปานกลาง', 'ต่ำ'];

function buildProductSection() {
  const products = getEnabledRiceProducts();
  if (!products.length) {
    return 'ผลิตภัณฑ์สมาร์ทกรีน: ยังไม่มีรายการสำหรับข้าว ให้ตอบ "smart_green_products": []';
  }
  const lines = products.map(p =>
    `  * ${p.name}: ${p.description} (ช่วยเรื่อง: ${p.fixes.join(', ')})${p.usage ? ` — อัตราใช้: ${p.usage}` : ''}`
  );
  return `ผลิตภัณฑ์สมาร์ทกรีน (SMART GREEN) ที่อนุญาตให้แนะนำเสริม:
${lines.join('\n')}
กติกา: แนะนำได้เฉพาะชื่อในรายการนี้ 0-3 รายการ ที่ตรงกับปัญหาที่พบจริงเท่านั้น ห้ามคิดชื่อหรือสูตรใหม่
ห้ามระบุอัตราใช้เองหากรายการไม่ได้ให้อัตราไว้ ให้เขียนว่า "ใช้ตามอัตราบนฉลาก" ผลิตภัณฑ์เหล่านี้เป็นตัวเสริม ไม่ใช่ตัวแทนแผนปุ๋ยหลัก
หากต้นสมบูรณ์ดีหรือไม่มีรายการที่ตรงปัญหา ให้ตอบ []`;
}

export function buildRicePrompt(payload) {
  const hasTree = Boolean(payload.images && payload.images.tree);
  const observed = Array.isArray(payload.observedSymptoms) && payload.observedSymptoms.length
    ? payload.observedSymptoms.join(', ')
    : '-';

  return `
คุณคือระบบ "Vision Ai วิเคราะห์ใบข้าว" ผู้เชี่ยวชาญด้านธาตุอาหารพืช โรคพืช และแมลงศัตรูข้าว (Oryza sativa) ในประเทศไทย"

ขั้นตอนที่ 1 — ตรวจสอบความถูกต้องของภาพ (บังคับ):
- ภาพต้องเป็นใบ/กอ/โคนกอ/รวงของ "ข้าว" (ใบแคบยาวแบบใบหญ้า มีเขี้ยวใบและหูใบที่คอใบ ขึ้นเป็นกอในนา)
- ดูจากภาพจริงเท่านั้น ห้ามใช้ข้อมูลแปลงหรืออาการที่ผู้ใช้กรอกมาแทนภาพ ข้อมูลแปลงใช้ประกอบการวินิจฉัยหลังจากภาพผ่านการตรวจแล้วเท่านั้น
- ให้บรรยายสิ่งที่เห็นจริงในแต่ละภาพลงใน "image_checks" ก่อนเสมอ
- ภาพถ่ายจริงจากแปลงที่เห็นใบหรือต้นเพียงบางส่วน หรือมีพื้นหลังรก ถือว่าผ่าน
- หากภาพใดไม่ใช่พืชนี้ (เช่น คน สัตว์ สิ่งของ เอกสาร หน้าจอ ภาพวาด/ภาพกราฟิก ภาพสีพื้นทึบ ใบพืชชนิดอื่น เช่น ข้าวโพด อ้อย หญ้า วัชพืชในนา เช่น หญ้าข้าวนก) หรือมืด/เบลอจนวิเคราะห์ไม่ได้ ให้ตอบ
  "is_rice": false และ "invalid_image_reason" ระบุอย่างสุภาพว่าภาพตำแหน่งใดไม่ถูกต้อง พร้อมแนะนำให้ถ่ายใหม่ (ฟิลด์อื่นใส่ค่าว่างได้)
- หากถูกต้องให้ตอบ "is_rice": true, "invalid_image_reason": ""

ขั้นตอนที่ 2 — ภาพที่ได้รับ (เรียงตามลำดับ):
1) ใบอ่อน / ใบยอด (ใบที่เพิ่งแทงออกจากกาบ) — ดูธาตุที่เคลื่อนย้ายยาก: Zn, S, Fe และโรคไหม้ หนอนห่อใบ แมลงบั่ว
2) ใบมาตรฐาน — ใบที่คลี่เต็มที่ใบบนสุด (ใบที่ใช้เทียบแถบสีใบ LCC ประเมินไนโตรเจน; ช่วงออกรวงใช้ใบธง) — ภาพตัวแทนสถานะธาตุอาหารของกอ
3) ใบล่าง / ใบแก่ — ดูธาตุที่เคลื่อนย้ายได้: N, P, K, Mg และโรคใบจุดสีน้ำตาล ขอบใบแห้ง กาบใบแห้ง
${hasTree ? '4) กอข้าว / รวง / โคนกอ — ใช้ดูการแตกกอ เพลี้ยกระโดดที่โคนกอ ยอดเหี่ยว (หนอนกอ) รวงขาว เมล็ดด่าง และอาการไหม้คอรวง' : '(ไม่มีภาพกอข้าว/รวง ให้ระบุ tree_analysis ว่า "ไม่มีภาพ")'}

ความรู้อ้างอิงอาการขาดธาตุของข้าว:
- N: (พบบ่อยที่สุด) ใบล่างเหลืองซีดทั้งใบ ต้นเตี้ย แตกกอน้อย สีใบอ่อนกว่าระดับ 3-4 ของแถบเทียบสีใบ (LCC)
- P: ใบสีเขียวเข้มหม่น ใบแคบสั้นตั้งตรง แตกกอน้อย ต้นแคระแกร็น ออกรวงช้า (ดินเปรี้ยว/ดินทราย)
- K: ปลายใบและขอบใบล่างเหลืองส้มแล้วแห้งเป็นสีน้ำตาล มีจุดสีน้ำตาลบนใบ ใบล่างลู่ ต้นอ่อนแอเป็นโรคง่าย
- Mg: ใบล่างเหลืองส้มระหว่างเส้นใบ ใบห้อยลู่
- S: ใบอ่อนเหลืองซีดทั้งใบ (ต่างจาก N ที่เริ่มจากใบล่าง) แตกกอน้อย
- Zn: (พบในดินด่าง/ดินเค็ม/นาที่น้ำขังตลอด) ใบอ่อนมีจุดและขีดสีน้ำตาลแดงคล้ายสนิม โคนใบซีดขาว ต้นเตี้ยแตกกอไม่สม่ำเสมอเป็นหย่อม ๆ
- Si: ใบนิ่มห้อยลู่ ต้นล้มง่าย เป็นโรคไหม้และใบจุดง่าย (ดินทรายที่ใช้ปลูกมานาน)
- Fe: ขาดเหล็ก — ใบอ่อนเหลืองขาวทั้งใบ (นาดอน/ดินด่าง); พิษเหล็ก (iron toxicity) — ใบล่างมีจุดน้ำตาลเล็ก ๆ แล้วเป็นสีส้มบรอนซ์ทั้งใบ พบมากในดินเปรี้ยวจัดที่มีน้ำขัง ให้ระบุในบทสรุปหากพบ

ความรู้อ้างอิงโรคและแมลงสำคัญของข้าว:
- โรคไหม้ (Blast, Pyricularia oryzae): แผลรูปตา/รูปข้าวหลามตัด ตรงกลางสีเทา ขอบสีน้ำตาล บนใบ; ระยะออกรวงทำให้คอรวงไหม้หักพับ — รุนแรง ระบาดเมื่ออากาศเย็นชื้นและใส่ N มาก
- โรคขอบใบแห้ง (Bacterial leaf blight, Xanthomonas oryzae): ขอบใบจากปลายใบเป็นทางสีเหลืองแล้วแห้งเป็นสีขาวเทา ขอบแผลเป็นคลื่น มีหยดน้ำเชื้อสีเหลืองช่วงเช้า — ระบาดหลังน้ำท่วม/ลมแรง
- โรคใบจุดสีน้ำตาล (Brown spot, Bipolaris oryzae): จุดแผลกลมรีสีน้ำตาล ตรงกลางสีเทา มักบ่งชี้ดินขาดธาตุอาหาร (K, Si)
- โรคกาบใบแห้ง (Sheath blight, Rhizoctonia solani): แผลรูปไข่สีเขียวอมเทาขอบสีน้ำตาลบนกาบใบใกล้ระดับน้ำ ลามขึ้นใบ
- โรคเมล็ดด่าง (Dirty panicle): เมล็ดมีจุดหรือสีน้ำตาลดำ (ระยะออกรวง)
- โรคใบหงิก (Ragged stunt) / โรคเขียวเตี้ย (Grassy stunt): ต้นเตี้ย ใบหงิกขอบแหว่ง หรือแตกกอมากใบแคบเหลือง — มีเพลี้ยกระโดดสีน้ำตาลเป็นพาหะ
- เพลี้ยกระโดดสีน้ำตาล (Brown planthopper, Nilaparvata lugens): ตัวสีน้ำตาลเกาะที่โคนกอ ต้นข้าวเหลืองแห้งเป็นหย่อมวงกลม (hopperburn) — รุนแรง
- หนอนห่อใบข้าว (Leaf folder): ใบถูกพับเป็นหลอด มีรอยขูดสีขาวเป็นทางยาว
- หนอนกอ (Stem borer): ยอดเหี่ยวแห้ง (dead heart) ระยะแตกกอ หรือรวงขาว (white head) ระยะออกรวง มีรูที่โคนต้น
- แมลงบั่ว (Rice gall midge): ใบเปลี่ยนเป็นหลอดคล้ายใบหอม (onion leaf) ไม่ออกรวง
- หอยเชอรี่: ต้นกล้า/ข้าวเล็กถูกกัดขาดหายเป็นหย่อม
- ความเครียดจากขาดน้ำ / ดินเค็ม: ปลายใบแห้งขาว ใบม้วน ต้นเตี้ย เป็นหย่อมหรือทั้งแปลง — ต้องแยกจากการขาด K

${buildProductSection()}

ข้อมูลแปลงจากผู้ใช้:
- ชื่อเกษตรกร / แปลง: ${payload.customerName || '-'}
- ผู้ตรวจ / ผู้ดูแล: ${payload.inspectorName || '-'}
- อายุหลังปลูก: ${payload.plantAge || '-'} วัน
- ฤดู / วิธีปลูก: ${payload.plantingSeason || '-'}
- พันธุ์: ${payload.variety || '-'}
- จังหวัด: ${payload.province || '-'}
- พิกัดแปลง (GPS): ${payload.coordinates || '-'}
- ชนิดดิน: ${payload.soilType || '-'}
- สภาพน้ำ/ความชื้น: ${payload.waterStatus || '-'}
- ค่า pH ดิน: ${payload.soilPh || 'ไม่ได้วัด'}
- ผลผลิตรอบก่อน: ${payload.yieldPerRai || '-'} กก./ไร่
- ปุ๋ยที่ใส่ล่าสุด: ${payload.lastFertilizer || '-'}
- อาการที่ผู้ใช้สังเกตเห็นในแปลง: ${observed}
- หมายเหตุเพิ่มเติม: ${payload.notes || '-'}

กติกาการวิเคราะห์:
1. ห้ามฟันธงจากภาพอย่างเดียว ใช้ความต่างระหว่างใบอ่อน / ใบมาตรฐาน / ใบล่าง และข้อมูลแปลงประกอบ
2. แยกอาการขาดธาตุ ออกจากโรค แมลง ความเครียดน้ำ และอาการจากสารเคมี (เช่น สารกำจัดวัชพืช) ให้ชัดเจน
3. หากไม่มั่นใจ ให้ระบุสถานะ "ต้องตรวจเพิ่ม" และแนะนำวิธีตรวจ (เก็บใบมาตรฐานส่งวิเคราะห์ห้องแล็บ / ตรวจดิน)
4. ต้องประเมินธาตุครบทั้ง 8 ตัว: N, P, K, Mg, S, Zn, Si, Fe โดยสถานะเลือกจาก: ${STATUS_LEVELS.join(' | ')}
5. ภาษาไทย อ่านง่าย ใช้ได้จริงสำหรับเกษตรกร
6. ตอบเป็น JSON เท่านั้น

แนวทางคำแนะนำปุ๋ย (ต่อไร่ ปรับตามชนิดดิน พันธุ์ และผลวิเคราะห์ดิน; ใช้แถบเทียบสีใบ LCC ช่วยตัดสินใจใส่ N):
- ดินเหนียว: รองพื้น 16-20-0 อัตรา 25-30 กก./ไร่ (นาหว่าน 15-20 วันหลังหว่าน / นาดำ 1-7 วันหลังปักดำ)
- ดินร่วนปนทราย / ดินทราย: รองพื้น 16-16-8 หรือ 15-15-15 อัตรา 25-30 กก./ไร่
- แต่งหน้า: ยูเรีย 46-0-0 อัตรา 5-15 กก./ไร่ ช่วงข้าวสร้างรวง (ประมาณ 55-60 วันก่อนเก็บเกี่ยว) — ข้าวไวต่อช่วงแสง (เช่น ขาวดอกมะลิ 105, กข6) ใส่ N น้อยกว่าข้าวไม่ไวแสง เพราะต้นสูงล้มง่าย
- หากสีใบต่ำกว่าระดับ 3 ของแถบเทียบสีใบ ให้เพิ่มยูเรีย 5-10 กก./ไร่ หากสูงกว่า 4 ให้งดใส่ N (ลดความเสี่ยงโรคไหม้และขอบใบแห้ง)
- โพแทสเซียม (ดินทราย/ขาด K): 0-0-60 อัตรา 5-10 กก./ไร่
- สังกะสี: ซิงค์ซัลเฟต 2-5 กก./ไร่ หรือพ่นทางใบ 0.5%
- ดินเปรี้ยวจัด: ใส่ปูนมาร์ล/โดโลไมท์ปรับ pH และระบายน้ำเป็นช่วง ๆ ลดพิษเหล็ก
- ใส่ปุ๋ยเมื่อมีน้ำในนา 5-10 ซม. หรือดินชื้น แล้วขังน้ำไว้ 2-3 วัน
- เพลี้ยกระโดดสีน้ำตาล: งดใช้สารกลุ่มไพรีทรอยด์และอะบาเมกตินที่ทำให้เพลี้ยระบาดเพิ่ม ใช้พันธุ์ต้านทาน และระบายน้ำออกจากนา

ให้ตอบเป็น JSON โครงสร้างนี้เท่านั้น:
{
  "image_checks": [
    { "slot": "young", "is_rice": true, "seen": "สิ่งที่เห็นจริงในภาพนี้ 1 ประโยค" }
  ],
  "is_rice": true,
  "invalid_image_reason": "",
  "young_leaf_analysis": "สรุปอาการใบอ่อน/ใบยอด 1-2 ประโยค",
  "mature_leaf_analysis": "สรุปอาการใบมาตรฐาน 1-2 ประโยค",
  "old_leaf_analysis": "สรุปอาการใบล่าง 1-2 ประโยค",
  "tree_analysis": "สรุปจากภาพกอข้าว/รวง หรือ 'ไม่มีภาพ'",
  "health_score": 75,
  "greenness_level": 3,
  "greenness_note": "สีใบโดยรวมและความหมายต่อไนโตรเจน 1 ประโยค",
  "primary_issue": "ปัญหาหลักสั้นๆ เช่น ขาดไนโตรเจน (N) ระดับปานกลาง",
  "overall_summary": "สรุปภาพรวม 2-4 ประโยค ข้อสันนิษฐานและเหตุผล",
  "nutrient_status": [
    { "code": "N", "status": "ปกติ", "evidence": "เหตุผล/อาการที่เห็นสั้นๆ" }
  ],
  "diseases": [
    { "name": "ชื่อโรคหรือแมลง", "type": "โรค หรือ แมลง หรือ ความเครียด", "likelihood": "สูง|ปานกลาง|ต่ำ", "evidence": "อาการที่เห็น", "management": "วิธีจัดการที่ทำได้จริง" }
  ],
  "fertilizer_plan": [
    { "nutrient": "N", "product": "ยูเรีย 46-0-0", "rate": "10 กก./ไร่", "timing": "ช่วงข้าวสร้างรวง", "method": "หว่านขณะมีน้ำในนา 5-10 ซม." }
  ],
  "smart_green_products": [
    { "name": "ชื่อผลิตภัณฑ์จากรายการที่อนุญาตเท่านั้น", "reason": "ช่วยแก้ปัญหาที่พบอย่างไร 1 ประโยค", "usage": "วิธีใช้/อัตรา (ถ้าไม่มีข้อมูลให้เขียน 'ใช้ตามอัตราบนฉลาก')" }
  ],
  "urgent_actions": ["สิ่งที่ควรทำทันทีภายใน 1-2 สัปดาห์"],
  "recommended_next_step": "ขั้นตอนถัดไป เช่น เก็บใบมาตรฐานส่งวิเคราะห์ ตรวจซ้ำใน 2 สัปดาห์",
  "confidence": "สูง|ปานกลาง|ต่ำ"
}
หมายเหตุ: "diseases" ให้ใส่เฉพาะที่มีหลักฐานจากภาพหรือข้อมูลแปลง หากไม่พบให้เป็น [] ; "health_score" 0-100 (100 = สมบูรณ์มาก)
"greenness_level" 1-5 = ระดับความเขียวของใบ เทียบแผ่นเทียบสีใบ (Leaf Color Chart) โดยดูจากใบมาตรฐาน (ใบที่คลี่เต็มที่ใบบนสุด) ในภาพ:
1 ซีด/เหลือง (ขาดไนโตรเจนรุนแรง) · 2 เขียวอ่อน (ควรเติมไนโตรเจน (ยูเรีย) ตามช่วงอายุข้าว) · 3 เขียวปกติ (เพียงพอ) · 4 เขียวสมบูรณ์ (ดี ยังไม่ต้องเพิ่มไนโตรเจน) · 5 เขียวเข้มจัด (ไนโตรเจนเกิน เสี่ยงโรคไหม้และเพลี้ยกระโดดสีน้ำตาล ควรงด/ลดปุ๋ยยูเรีย)
ให้คำนึงถึงแสงและเงาในภาพ ถ้าภาพย้อนแสงหรือสีเพี้ยนให้ประเมินอย่างระมัดระวังและบอกไว้ใน "greenness_note"
`.trim();
}

function asString(v, fallback = '-') {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function pickEnum(value, allowed, fallback) {
  const s = asString(value, '');
  return allowed.find(a => s === a) || allowed.find(a => s.includes(a)) || fallback;
}

/** Normalize the AI reply into a predictable shape for the frontend. */
export function normalizeRiceResult(parsed, payload) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};

  const nutrientMap = new Map();
  for (const item of Array.isArray(p.nutrient_status) ? p.nutrient_status : []) {
    if (!item || typeof item !== 'object') continue;
    const code = asString(item.code || item.nutrient, '').replace(/[^A-Za-z]/g, '');
    const match = RICE_NUTRIENTS.find(n => n.code.toLowerCase() === code.toLowerCase());
    if (match) nutrientMap.set(match.code, item);
  }
  const nutrientStatus = RICE_NUTRIENTS.map(n => {
    const item = nutrientMap.get(n.code) || {};
    return {
      code: n.code,
      name: n.name,
      status: pickEnum(item.status, STATUS_LEVELS, 'ต้องตรวจเพิ่ม'),
      evidence: asString(item.evidence, 'ไม่พบข้อมูลจากภาพ'),
    };
  });

  const diseases = (Array.isArray(p.diseases) ? p.diseases : [])
    .filter(d => d && typeof d === 'object' && d.name)
    .map(d => ({
      name: asString(d.name),
      type: asString(d.type, 'โรค'),
      likelihood: pickEnum(d.likelihood, LIKELIHOODS, 'ต่ำ'),
      evidence: asString(d.evidence),
      management: asString(d.management),
    }));

  const fertilizerPlan = (Array.isArray(p.fertilizer_plan) ? p.fertilizer_plan : [])
    .filter(f => f && typeof f === 'object' && (f.product || f.nutrient))
    .map(f => ({
      nutrient: asString(f.nutrient, ''),
      product: asString(f.product),
      rate: asString(f.rate),
      timing: asString(f.timing),
      method: asString(f.method),
    }));

  const seenProducts = new Set();
  const smartGreenProducts = [];
  for (const item of Array.isArray(p.smart_green_products) ? p.smart_green_products : []) {
    if (!item || typeof item !== 'object') continue;
    const product = matchRiceProduct(normalizeSmartGreenProductText(asString(item.name, '')));
    if (!product || seenProducts.has(product.key)) continue; // drop anything not on the approved list
    seenProducts.add(product.key);
    smartGreenProducts.push({
      key: product.key,
      name: product.name,
      image: product.image,
      reason: normalizeSmartGreenProductText(asString(item.reason, product.description)),
      // Only show rates the technical team approved in riceProducts.js — never AI-invented ones
      usage: product.usage || 'ใช้ตามอัตราบนฉลาก',
    });
  }

  let score = parseInt(p.health_score, 10);
  if (Number.isNaN(score)) score = 60;
  score = Math.max(0, Math.min(100, score));

  let greenness = parseInt(p.greenness_level, 10);
  greenness = Number.isNaN(greenness) ? null : Math.max(1, Math.min(5, greenness));

  const urgent = Array.isArray(p.urgent_actions)
    ? p.urgent_actions.map(a => asString(a, '')).filter(Boolean)
    : (p.urgent_actions ? [asString(p.urgent_actions)] : []);

  return {
    success: true,
    crop: 'rice',
    customerName: payload.customerName || '',
    inspectorName: payload.inspectorName || '',
    plantAge: payload.plantAge || '',
    plantingSeason: payload.plantingSeason || '',
    variety: payload.variety || '',
    province: payload.province || '',
    coordinates: payload.coordinates || '',
    soilType: payload.soilType || '',
    waterStatus: payload.waterStatus || '',
    soilPh: payload.soilPh || 'ไม่ได้วัด',
    yieldPerRai: payload.yieldPerRai || '',
    lastFertilizer: payload.lastFertilizer || '',
    observedSymptoms: Array.isArray(payload.observedSymptoms) ? payload.observedSymptoms : [],
    youngLeafAnalysis: asString(p.young_leaf_analysis),
    matureLeafAnalysis: asString(p.mature_leaf_analysis),
    oldLeafAnalysis: asString(p.old_leaf_analysis),
    treeAnalysis: asString(p.tree_analysis, 'ไม่มีภาพ'),
    healthScore: score,
    greennessLevel: greenness,
    greennessNote: asString(p.greenness_note, ''),
    primaryIssue: asString(p.primary_issue, 'ต้องตรวจเพิ่ม'),
    overallSummary: asString(p.overall_summary),
    nutrientStatus,
    diseases,
    fertilizerPlan,
    smartGreenProducts,
    urgentActions: urgent,
    recommendedNextStep: asString(p.recommended_next_step),
    confidence: pickEnum(p.confidence, LIKELIHOODS, 'ปานกลาง'),
  };
}

/** Returns an error message (Thai) when the payload is invalid, otherwise null. */
export function validateRicePayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.images) {
    return 'ไม่พบข้อมูลรูปภาพ';
  }
  const missing = RICE_IMAGE_SLOTS
    .filter(s => s.required && !(payload.images[s.key] && payload.images[s.key].base64))
    .map(s => s.label);
  if (missing.length) {
    return `กรุณาอัปโหลดรูปให้ครบ: ${missing.join(', ')}`;
  }
  return null;
}

/** Labels of submitted image slots the model marked as not-rice in image_checks. */
export function failedImageChecks(parsed, payload) {
  const checks = parsed && Array.isArray(parsed.image_checks) ? parsed.image_checks : [];
  return RICE_IMAGE_SLOTS
    .filter((slot) => payload.images && payload.images[slot.key])
    .filter((slot) => checks.some((c) => c && c.slot === slot.key && (c.is_rice === false || c.is_rice === 'false')))
    .map((slot) => slot.label);
}

const PRECHECK_PROMPT = `
ตรวจภาพแต่ละภาพด้านบนอย่างเข้มงวด โดยดูจากภาพเท่านั้น (ไม่มีข้อมูลอื่นประกอบ)
ภาพผ่านได้เมื่อเป็น "ภาพถ่ายจริง" ที่เห็นส่วนของต้นข้าวชัดเจน: ใบ กอ โคนกอ หรือรวง
(ใบข้าวแคบยาวแบบใบหญ้า ขึ้นเป็นกอในนา; ภาพนาจริงที่มีน้ำ วัชพืช หรือพื้นหลังรก หรือเห็นต้นข้าวเพียงบางส่วนถือว่าผ่าน)
ภาพไม่ผ่าน: ภาพวาด ภาพกราฟิก ลวดลาย/รูปทรงเรขาคณิต ภาพสีพื้น ภาพหน้าจอ เอกสาร คน สัตว์ สิ่งของ
พืชชนิดอื่น (ข้าวโพด อ้อย หญ้า ฯลฯ) หรือภาพมืด/เบลอจนมองไม่เห็นใบหรือต้น
ตอบ JSON เท่านั้น: {"image_checks":[{"slot":"young","is_rice":true,"seen":"สิ่งที่เห็นจริงในภาพ 1 ประโยค"}]}
`.trim();

function imageParts(payload) {
  const parts = [];
  for (const slot of RICE_IMAGE_SLOTS) {
    const img = payload.images[slot.key];
    if (img && img.base64) {
      parts.push({ text: `ภาพ slot="${slot.key}": ${slot.label}` });
      parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } });
    }
  }
  return parts;
}

/**
 * Step 1: judge the photos alone, without the farmer's text. With symptoms in the prompt the
 * model tends to "see" them in any image, so this check must not see the context.
 * Returns labels of failed slots; fails open (returns []) if the check itself errors or times out.
 */
export async function precheckImages(payload, traceId) {
  try {
    const parsed = await generateJsonWithFallback([...imageParts(payload), { text: PRECHECK_PROMPT }],
      `${traceId}-precheck`, { timeoutMs: 12000, totalBudgetMs: 18000 });
    const failed = failedImageChecks(parsed, payload);
    if (failed.length) console.warn(`[${traceId}] precheck rejected:`, JSON.stringify(parsed.image_checks));
    return failed;
  } catch (err) {
    console.warn(`[${traceId}] precheck skipped:`, err.message);
    return [];
  }
}

export async function analyzeRice(payload, traceId) {
  // Images go first (each labelled with its slot key) so the model looks at the photos
  // before it reads the farmer's context, which otherwise invites made-up findings.
  const contents = [...imageParts(payload), { text: buildRicePrompt(payload) }];

  // Photo check and analysis run at the same time (saves the check's 3-6 s wait).
  // If the photos fail the check, the analysis result is thrown away.
  const precheck = precheckImages(payload, traceId);
  const analysis = generateJsonWithFallback(contents, traceId, { timeoutMs: 22000, totalBudgetMs: 38000 });
  analysis.catch(() => {}); // avoid an unhandled rejection when the photo check fails first

  const rejected = await precheck;
  if (rejected.length) {
    const err = new Error(`ภาพตำแหน่ง ${rejected.join(', ')} ไม่ใช่ภาพถ่ายข้าวที่วิเคราะห์ได้ กรุณาถ่ายภาพใบข้าวจริงใหม่อีกครั้ง`);
    err.isInvalidImage = true;
    throw err;
  }

  const parsed = await analysis;

  const failed = failedImageChecks(parsed, payload);
  if (parsed && (parsed.is_rice === false || failed.length)) {
    const err = new Error(
      parsed.invalid_image_reason ||
      (failed.length ? `ภาพตำแหน่ง ${failed.join(', ')} ไม่ใช่ภาพข้าวที่วิเคราะห์ได้ กรุณาถ่ายภาพใหม่อีกครั้ง` : '') ||
      'ระบบตรวจพบว่าภาพที่อัปโหลดไม่ใช่ข้าว กรุณาถ่ายภาพใบข้าวใหม่อีกครั้ง'
    );
    err.isInvalidImage = true;
    throw err;
  }

  return normalizeRiceResult(parsed, payload);
}

/**
 * Framework-agnostic request handler: takes a parsed payload, returns { status, body }.
 * Used by the Vercel function api/analyze.js (also run by the local server.js).
 */
export async function handleRiceRequest(payload) {
  const traceId = `RICE-${Date.now()}`;
  const invalid = validateRicePayload(payload);
  if (invalid) return { status: 400, body: { error: invalid } };

  try {
    const result = await analyzeRice(payload, traceId);
    result.traceId = traceId;
    console.log(`[${traceId}] SUCCESS | ${result.primaryIssue} | score ${result.healthScore}`);
    return { status: 200, body: result };
  } catch (err) {
    if (err.isInvalidImage) {
      console.warn(`[${traceId}] REJECTED image:`, err.message);
      return { status: 400, body: { success: false, isInvalidImage: true, error: err.message } };
    }
    console.error(`[${traceId}] FAILED:`, err);
    const msg = String(err?.message || err);
    if (isBusyError(err) || /หมดเวลา/.test(msg)) {
      return { status: 503, body: { error: BUSY_MESSAGE_TH } };
    }
    return { status: 500, body: { error: `เกิดข้อผิดพลาดในการวิเคราะห์: ${err?.message || err}` } };
  }
}
