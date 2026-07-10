const https = require('https');

module.exports = async (req, res) => {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const { base64, mediaType } = req.body;

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `Kamu adalah asisten kasir toko listrik & bangunan di Indonesia. Baca nota/faktur pembelian ini.

Kembalikan HANYA JSON tanpa markdown:
{
  "supplier": "nama toko/supplier penjual yang tertera di nota",
  "tanggal": "YYYY-MM-DD atau string kosong jika tidak ada",
  "status_bayar": "Lunas atau Hutang (deteksi dari nota: jika ada tulisan kredit/hutang/belum lunas = Hutang, jika tunai/cash/lunas = Lunas, default Lunas)",
  "items": [
    {"nama": "nama produk lengkap", "qty": angka, "harga": angka satuan, "satuan": "pcs/roll/meter/dll"}
  ],
  "total": angka total keseluruhan,
  "catatan": "catatan tambahan dari nota jika ada",
  "no_nota": "nomor nota/faktur jika ada"
}

Aturan penting:
- Angka: hilangkan titik/koma pemisah ribuan, jadikan integer (Rp 1.500 = 1500)
- Nama produk: tulis lengkap termasuk spesifikasi
- Jika nota kredit/tempo = status_bayar Hutang
- Jika ada diskon per item, harga sudah dikurangi diskon`
          }
        ]
      }]
    });

    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      });
      req2.on('error', reject);
      req2.write(payload);
      req2.end();
    });

    const responseData = JSON.parse(result.body);
    
    if(result.status !== 200) {
      return res.status(500).json({ error: responseData.error?.message || 'Anthropic API error' });
    }

    const text = responseData.content?.[0]?.text || '';
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
