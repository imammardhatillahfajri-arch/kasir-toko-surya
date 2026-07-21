const https = require('https');

async function callAnthropic(payload) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const body = req.body;

    // ── MODE: AI PRODUCT MATCHING ──
    if (body.matchMode) {
      const { itemList, prodList } = body;
      const result = await callAnthropic({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Cocokkan item dari nota pembelian ke produk database toko.

ITEM DARI NOTA:
${itemList}

DATABASE PRODUK (format: id|nama):
${prodList}

Kembalikan HANYA JSON:
{
  "matches": {
    "1": {"product_id": "123", "confidence": "high/medium/low/none"},
    "2": {"product_id": null, "confidence": "none"},
    ...
  }
}

Aturan:
- Cocokkan berdasarkan kesamaan produk meskipun nama berbeda (singkatan, merk, spesifikasi)
- product_id = null jika tidak ada yang cocok
- confidence: high=sangat yakin, medium=kemungkinan besar, low=mungkin, none=tidak ada
- Hanya return product_id yang confidence-nya high atau medium`
        }]
      });

      const data = JSON.parse(result.body);
      const text = data.content?.[0]?.text || '';
      const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      return res.status(200).json(JSON.parse(clean));
    }

    // ── MODE: ANALYZE NOTA PENJUALAN MANUAL (foto catatan kasir tulisan tangan) ──
    if (body.salesMode) {
      const { base64, mediaType } = body;
      const result = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `Kamu adalah asisten kasir toko listrik & bangunan di Indonesia. Baca nota penjualan MANUAL/TULISAN TANGAN ini — dicatat kasir di kertas saat toko sedang ramai, untuk dimasukkan ke sistem nanti.

Kembalikan HANYA JSON tanpa markdown:
{
  "pelanggan": "nama pembeli jika tertulis, kosongkan (string kosong) jika tidak ada/umum",
  "tanggal": "YYYY-MM-DD, kosongkan jika tidak tertulis",
  "status_bayar": "Lunas atau Piutang",
  "items": [
    {"nama": "nama produk lengkap sesuai tulisan", "qty": angka, "harga": angka harga jual satuan, "satuan": "pcs/roll/meter/dll"}
  ],
  "total": angka total keseluruhan jika tertulis atau bisa dihitung,
  "catatan": "catatan tambahan dari nota jika ada, mis. nomor HP pelanggan"
}

Aturan:
- Angka tanpa titik/koma (Rp 1.500 ditulis 1500)
- Tulisan tangan mungkin tidak rapi — lakukan interpretasi terbaik berdasarkan konteks toko listrik/bangunan
- Kalau ada tulisan "blm lunas", "hutang", "kurang Rp...", atau nominal bayar lebih kecil dari total = status_bayar "Piutang"
- Kalau tidak ada indikasi utang sama sekali = status_bayar "Lunas"
- Kalau satuan tidak jelas, gunakan "pcs" sebagai default` }
          ]
        }]
      });

      const data = JSON.parse(result.body);
      if (result.status !== 200) {
        return res.status(500).json({ error: data.error?.message || 'API error' });
      }
      const text = data.content?.[0]?.text || '';
      const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();

      let parsed;
      try { parsed = JSON.parse(clean); }
      catch(e) {
        const m = clean.match(/[{][\s\S]*[}]/);
        if(m) parsed = JSON.parse(m[0]);
        else throw new Error('AI tidak bisa membaca nota penjualan ini');
      }
      return res.status(200).json(parsed);
    }

    // ── MODE: BACA DAFTAR HARGA SUPPLIER (foto atau PDF, buat update harga massal) ──
    if (body.priceListMode) {
      const { base64, mediaType } = body;
      const isPdf = mediaType === 'application/pdf';
      const fileBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
      const result = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            fileBlock,
            { type: 'text', text: `Kamu adalah asisten toko listrik & bangunan di Indonesia. Ini adalah DAFTAR HARGA / PRICE LIST terbaru dari supplier — bisa berupa foto atau dokumen PDF berisi banyak baris produk dengan harga barunya. Baca SEMUA baris/item yang ada, jangan ada yang terlewat meskipun daftarnya panjang.

Kembalikan HANYA JSON tanpa markdown:
{
  "supplier": "nama supplier/distributor jika tertera, kosongkan jika tidak ada",
  "tanggal": "YYYY-MM-DD tanggal berlaku daftar harga jika tertera, kosongkan jika tidak ada",
  "items": [
    {"nama": "nama produk lengkap (TANPA embel-embel @NNN)", "harga": angka harga baru per satuan, "satuan": "pcs/roll/meter/dus/dll", "isi_per_satuan": angka atau null}
  ]
}

Aturan: Angka tanpa titik/koma (Rp 15.000 = 15000). Kalau ada beberapa kolom harga per baris (misal harga grosir vs eceran, atau per beberapa level satuan), ambil harga yang paling relevan untuk PEMBELIAN toko dari supplier ini (biasanya kolom "Harga" atau kolom pertama, BUKAN harga jual/retail ke konsumen akhir kalau ada dua-duanya tertera).

PENTING soal isi_per_satuan: sama seperti nota pembelian, kalau nama produk ada embel-embel "@NNN" (contoh "ELBOW 1/2\\" AW PRALON @225") artinya 1 satuan yang dijual (misal 1 DUS) isinya NNN pcs. Set isi_per_satuan = angka itu (contoh 225), dan JANGAN ikutkan "@NNN" di field nama. Kalau tidak ada pola ini, isi_per_satuan = null.` }
          ]
        }]
      });

      const data = JSON.parse(result.body);
      if (result.status !== 200) {
        return res.status(500).json({ error: data.error?.message || 'API error' });
      }
      const text = data.content?.[0]?.text || '';
      const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();

      let parsed;
      try { parsed = JSON.parse(clean); }
      catch(e) {
        const m = clean.match(/[{][\s\S]*[}]/);
        if(m) parsed = JSON.parse(m[0]);
        else throw new Error('AI tidak bisa membaca daftar harga ini');
      }
      return res.status(200).json(parsed);
    }

    // ── MODE: ANALYZE NOTA PEMBELIAN (foto faktur/nota dari supplier) ──
    const { base64, mediaType } = body;
    const result = await callAnthropic({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: `Kamu adalah asisten kasir toko listrik & bangunan di Indonesia. Baca nota/faktur pembelian ini.

Kembalikan HANYA JSON tanpa markdown:
{
  "supplier": "nama toko/supplier penjual yang tertera di nota",
  "tanggal": "YYYY-MM-DD atau string kosong jika tidak ada",
  "status_bayar": "Lunas atau Hutang",
  "items": [
    {"nama": "nama produk lengkap (TANPA embel-embel @NNN)", "qty": angka, "harga": angka satuan (SEBELUM diskon), "satuan": "pcs/roll/meter/dus/dll", "isi_per_satuan": angka atau null, "diskon_persen": "string atau null"}
  ],
  "total": angka total keseluruhan,
  "catatan": "catatan tambahan dari nota jika ada",
  "no_nota": "nomor nota/faktur jika ada"
}

Aturan: Angka tanpa titik/koma (Rp 1.500 = 1500). Kredit/tempo = Hutang. Tunai/cash = Lunas. "harga" SELALU harga satuan SEBELUM diskon dipotong (harga kotor/asli), JANGAN dihitung setelah diskon — pemotongan diskon dilakukan sistem, bukan kamu.

PENTING soal isi_per_satuan: supplier sering nulis nama barang dengan embel-embel "@NNN" (contoh: "ELBOW 1/2\\" AW PRALON @225"), artinya 1 satuan yang dibeli (misal 1 DUS) isinya NNN pcs (di contoh ini 225 pcs per dus). Kalau kamu temukan pola "@angka" ini:
- Set isi_per_satuan = angka tersebut (contoh: 225)
- Nama produk di field "nama" JANGAN ikutkan "@NNN"-nya, cukup nama bersih
Kalau tidak ada pola "@angka" atau satuannya memang sudah "pcs", isi_per_satuan = null.

PENTING soal diskon_persen: banyak nota/faktur (terutama dari distributor pipa/listrik) punya kolom "DISCOUNT" berjenjang, biasanya tertulis sebagai beberapa persentase berurutan per baris item, contoh kolom "1%: 5.00", "2%: 5.00", "3%: 5.00" — ini artinya diskon berjenjang 5% lalu 5% lagi lalu 5% lagi (bukan dijumlah jadi 15%, tapi dipotong berturut-turut). Kalau kamu temukan kolom diskon seperti ini per item:
- Gabungkan semua angka persen yang ada (yang bukan nol/kosong) dengan tanda "+", urut dari kolom paling kiri. Contoh: kolom 1%=20.00, 2%=5.00, 3%=5.00 → diskon_persen = "20+5+5"
- Kalau cuma ada satu angka diskon (bukan berjenjang) → diskon_persen = angka itu saja, contoh "10"
- Kalau kolom diskon semuanya kosong/nol/tidak ada sama sekali → diskon_persen = null
- JANGAN menghitung sendiri hasil potongannya — cukup kembalikan angka persennya, sistem yang akan menghitung.` }
        ]
      }]
    });

    const data = JSON.parse(result.body);
    if (result.status !== 200) {
      return res.status(500).json({ error: data.error?.message || 'API error' });
    }

    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    
    // Try extract JSON if not pure JSON
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch(e) {
      const m = clean.match(/[{][\s\S]*[}]/);
      if(m) parsed = JSON.parse(m[0]);
      else throw new Error('AI tidak bisa membaca nota');
    }

    return res.status(200).json(parsed);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
