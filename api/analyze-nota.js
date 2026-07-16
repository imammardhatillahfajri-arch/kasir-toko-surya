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
    {"nama": "nama produk lengkap", "qty": angka, "harga": angka satuan, "satuan": "pcs/roll/meter/dll"}
  ],
  "total": angka total keseluruhan,
  "catatan": "catatan tambahan dari nota jika ada",
  "no_nota": "nomor nota/faktur jika ada"
}

Aturan: Angka tanpa titik/koma (Rp 1.500 = 1500). Kredit/tempo = Hutang. Tunai/cash = Lunas.` }
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
