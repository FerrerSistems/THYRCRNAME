const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_KEY || null;

app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/') return next();
  const key = req.query.apikey || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ estado: false, mensaje: 'API key inválida' });
  next();
});

const BASE = 'https://servicioselectorales.tse.go.cr';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ════════════════════════════════════════════════════════════
// COOKIES BASE — actualizar cuando expiren (copiar del navegador)
// ════════════════════════════════════════════════════════════
const COOKIES_BASE = '__ssds=0; __ssuzjsr0=a9be0cd8e; __uzmbj0=1761508748; __uzmlj0=aXessLrBHZU39rtdriuUI7+S+LgMlsZhWGAfQqpKF6g=; _ga=GA1.1.1881706855.1727492922; __uzma=7c359469-dc71-4e9d-95d0-7f3edcbcf362; __uzmb=1782439676; __uzme=6585; ASP.NET_SessionId=3yyry5kdxr02zvmzkabjfzqb; __uzmaj0=7c359469-dc71-4e9d-95d0-7f3edcbcf362; __utmc=258596104; __utmz=258596104.1782439716.7.1.utmccn=(direct)|utmcsr=(direct)|utmcmd=(none); _ga_EMVSBHTSQQ=GS2.1.s1782439664$o2$g0$t1782441432$j60$l0$h0; __utma=258596104.134802366.1746460238.1782439716.1782441700.8; __utmb=258596104; __uzmcj0=200153187055; __uzmdj0=1782442460; __uzmfj0=7f90007c359469-dc71-4e9d-95d0-7f3edcbcf3628-176150874817520933712093-0033661b90eef8c7e4331; uzmxj=7f900037bceb0b-8599-4365-87d3-2c18ff08e3d08-176150874817520933712093-d302bd054faae09c799';

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function parseCookies(header, jar = {}) {
  const arr = Array.isArray(header) ? header : header ? [header] : [];
  for (const c of arr) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

function cookieStr(jar) {
  const base = {};
  for (const part of COOKIES_BASE.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) base[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return Object.entries({ ...base, ...jar }).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractVS(html) {
  const $ = cheerio.load(html);
  return {
    __VIEWSTATE:          $('input[name="__VIEWSTATE"]').val()          || '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    __EVENTVALIDATION:    $('input[name="__EVENTVALIDATION"]').val()    || '',
  };
}

function updateVSFromAsync(text, vs) {
  const m1 = text.match(/\d+\|hiddenField\|__VIEWSTATE\|([^|]+)\|/);
  const m2 = text.match(/\d+\|hiddenField\|__VIEWSTATEGENERATOR\|([^|]+)\|/);
  const m3 = text.match(/\d+\|hiddenField\|__EVENTVALIDATION\|([^|]+)\|/);
  if (m1) vs.__VIEWSTATE          = m1[1];
  if (m2) vs.__VIEWSTATEGENERATOR = m2[1];
  if (m3) vs.__EVENTVALIDATION    = m3[1];
  return vs;
}

function isBotBlock(html) {
  return html.includes('Radware Bot Manager') || html.includes('hcaptcha') || html.includes('Bot Manager Captcha');
}

// ════════════════════════════════════════════════════════════
// HTTP CLIENT con headers completos de Chrome 149
// ════════════════════════════════════════════════════════════
function headersGet(jar, referer, fromGoogle = false) {
  return {
    'User-Agent':              UA,
    'Accept':                  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language':         'es-PE,es-419;q=0.9,es;q=0.8',
    'Accept-Encoding':         'gzip, deflate, br, zstd',
    'Connection':              'keep-alive',
    'Upgrade-Insecure-Requests':'1',
    'sec-ch-ua':               '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile':        '?0',
    'sec-ch-ua-platform':      '"Windows"',
    'sec-fetch-dest':          'document',
    'sec-fetch-mode':          'navigate',
    'sec-fetch-site':          fromGoogle ? 'cross-site' : 'same-origin',
    'sec-fetch-user':          '?1',
    'priority':                'u=0, i',
    'Referer':                 referer || 'https://www.google.com/',
    'Cookie':                  cookieStr(jar),
  };
}

function headersPost(jar, referer) {
  return {
    'User-Agent':              UA,
    'Accept':                  '*/*',
    'Accept-Language':         'es-PE,es-419;q=0.9,es;q=0.8',
    'Accept-Encoding':         'gzip, deflate, br, zstd',
    'Content-Type':            'application/x-www-form-urlencoded;charset=UTF-8',
    'X-MicrosoftAjax':         'Delta=true',
    'X-Requested-With':        'XMLHttpRequest',
    'sec-ch-ua':               '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile':        '?0',
    'sec-ch-ua-platform':      '"Windows"',
    'sec-fetch-dest':          'empty',
    'sec-fetch-mode':          'cors',
    'sec-fetch-site':          'same-origin',
    'priority':                'u=1, i',
    'Origin':                  BASE,
    'Referer':                 referer,
    'Cookie':                  cookieStr(jar),
  };
}

async function httpGet(url, jar, referer, fromGoogle = false) {
  console.log(`  [GET] ${url}`);
  try {
    const r = await axios.get(url, {
      headers: headersGet(jar, referer, fromGoogle),
      timeout: 25000,
      validateStatus: s => s < 600,
      decompress: true,
    });
    parseCookies(r.headers['set-cookie'], jar);
    console.log(`  [GET] STATUS=${r.status} | len=${r.data ? r.data.length : 0} | bot=${isBotBlock(r.data||'')}`);
    return r;
  } catch (e) {
    console.error(`  [GET] ERROR: ${e.message}`);
    throw e;
  }
}

async function httpPost(url, body, jar, referer) {
  console.log(`  [POST] ${url}`);
  console.log(`  [POST] body: ${body.toString().slice(0, 150)}`);
  try {
    const r = await axios.post(url, body.toString(), {
      headers: headersPost(jar, referer),
      timeout: 25000,
      validateStatus: s => s < 600,
      decompress: true,
    });
    parseCookies(r.headers['set-cookie'], jar);
    console.log(`  [POST] STATUS=${r.status} | len=${r.data ? r.data.length : 0} | bot=${isBotBlock(r.data||'')}`);
    return r;
  } catch (e) {
    console.error(`  [POST] ERROR: ${e.message}`);
    throw e;
  }
}

// ════════════════════════════════════════════════════════════
// CAPTURAR COOKIES FRESCAS (si hay bloqueo)
// Visita la home del TSE para obtener cookies nuevas de Radware
// ════════════════════════════════════════════════════════════
async function refrescarCookies(jar) {
  console.log(`  [COOKIE-REFRESH] Obteniendo cookies frescas desde home TSE...`);
  try {
    // Paso 1: visitar home como si viniéramos de Google
    const r1 = await axios.get(`${BASE}/`, {
      headers: headersGet(jar, 'https://www.google.com/', true),
      timeout: 20000,
      validateStatus: s => s < 600,
      decompress: true,
    });
    parseCookies(r1.headers['set-cookie'], jar);
    console.log(`  [COOKIE-REFRESH] Home STATUS=${r1.status} | cookies=${JSON.stringify(jar).slice(0, 100)}`);

    // Paso 2: visitar consulta_nombres para obtener sesión ASP.NET
    await new Promise(r => setTimeout(r, 800));
    const r2 = await axios.get(`${BASE}/chc/consulta_nombres.aspx`, {
      headers: headersGet(jar, `${BASE}/`, false),
      timeout: 20000,
      validateStatus: s => s < 600,
      decompress: true,
    });
    parseCookies(r2.headers['set-cookie'], jar);
    console.log(`  [COOKIE-REFRESH] consulta_nombres STATUS=${r2.status}`);
    return !isBotBlock(r2.data || '');
  } catch (e) {
    console.error(`  [COOKIE-REFRESH] ERROR: ${e.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// PARSER muestra_nombres.aspx
// ════════════════════════════════════════════════════════════
function parseMuestra(html) {
  const $        = cheerio.load(html);
  const personas = [];

  // Método 1: labels de checkboxes en #chk1
  $('#chk1 label').each((_, el) => {
    const txt = $(el).text().trim();
    const m   = txt.match(/^\d+[-–]\s*(\d{5,12})\s+(.+)$/);
    if (m) personas.push({ cedula: m[1].trim(), nombre: m[2].replace(/\s+/g, ' ').trim() });
  });

  // Método 2: DropDownList
  if (personas.length === 0) {
    $('select option').each((_, el) => {
      const val = $(el).attr('value') || '';
      const txt = $(el).text().trim();
      if (/^\d{5,12}$/.test(val) && txt) {
        personas.push({ cedula: val, nombre: txt.replace(/\s+/g, ' ').trim() });
      }
    });
  }

  // Método 3: spans/td con patrón cédula + nombre
  if (personas.length === 0) {
    $('span, td, li').each((_, el) => {
      const txt = $(el).text().trim();
      const m   = txt.match(/(\d{9,12})\s{2,}([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ\s]+)/);
      if (m && !personas.find(p => p.cedula === m[1])) {
        personas.push({ cedula: m[1].trim(), nombre: m[2].replace(/\s+/g, ' ').trim() });
      }
    });
  }

  const paginacion = $('#lblmensajes').text().trim() || null;
  return { personas, paginacion };
}

// ════════════════════════════════════════════════════════════
// CONSULTA POR NOMBRE — con retry automático si hay bloqueo
// ════════════════════════════════════════════════════════════
async function consultaNombre(nombre, apellido1, apellido2, intento = 1) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[TSE-NOM] Intento ${intento} | nombre="${nombre}" ap1="${apellido1}" ap2="${apellido2}"`);
  console.log(`${'='.repeat(60)}`);

  let jar = {};

  // Si es reintento, refrescar cookies primero
  if (intento > 1) {
    console.log(`[TSE-NOM] Reintento ${intento}: refrescando cookies...`);
    const ok = await refrescarCookies(jar);
    if (!ok) throw new Error('Bloqueado por bot manager — refrescar cookies del navegador en COOKIES_BASE');
    await new Promise(r => setTimeout(r, 1200));
  }

  // P1: GET consulta_nombres
  console.log(`\n--- P1: GET consulta_nombres ---`);
  const r1 = await httpGet(`${BASE}/chc/consulta_nombres.aspx`, jar, 'https://www.google.com/', intento === 1);

  if (isBotBlock(r1.data || '')) {
    if (intento < 3) {
      console.warn(`[TSE-NOM] ⚠️ Bot block en P1, reintentando (${intento+1}/3)...`);
      await new Promise(r => setTimeout(r, 2000));
      return consultaNombre(nombre, apellido1, apellido2, intento + 1);
    }
    throw new Error('Bloqueado por bot manager en P1 — actualizar COOKIES_BASE');
  }

  let vs = extractVS(r1.data);
  console.log(`[P1] ViewState length: ${vs.__VIEWSTATE.length}`);
  if (!vs.__VIEWSTATE) {
    console.error(`[P1] HTML completo:\n${r1.data.slice(0, 800)}`);
    if (intento < 3) {
      await new Promise(r => setTimeout(r, 2000));
      return consultaNombre(nombre, apellido1, apellido2, intento + 1);
    }
    throw new Error('No se obtuvo ViewState de consulta_nombres');
  }
  console.log(`[P1] ✅ ViewState OK`);

  // Delay humano
  await new Promise(r => setTimeout(r, 400 + Math.random() * 600));

  // P2: POST buscar nombre
  console.log(`\n--- P2: POST buscar nombre ---`);
  const b2 = new URLSearchParams({
    'ScriptManager1':      'UpdatePanel1|btnConsultarNombre',
    '__LASTFOCUS':         '',
    '__EVENTTARGET':       '',
    '__EVENTARGUMENT':     '',
    '__VIEWSTATE':          vs.__VIEWSTATE,
    '__VIEWSTATEGENERATOR': vs.__VIEWSTATEGENERATOR,
    '__EVENTVALIDATION':    vs.__EVENTVALIDATION,
    'txtnombre':            nombre.toUpperCase(),
    'txtapellido1':         apellido1.toUpperCase(),
    'txtapellido2':         apellido2 ? apellido2.toUpperCase() : '',
    'referencia':           '',
    'observacion':          '',
    '__ASYNCPOST':          'true',
    'btnConsultarNombre':   'Consultar',
  });

  const r2 = await httpPost(`${BASE}/chc/consulta_nombres.aspx`, b2, jar, `${BASE}/chc/consulta_nombres.aspx`);

  if (isBotBlock(r2.data || '')) {
    if (intento < 3) {
      console.warn(`[TSE-NOM] ⚠️ Bot block en P2, reintentando...`);
      await new Promise(r => setTimeout(r, 2500));
      return consultaNombre(nombre, apellido1, apellido2, intento + 1);
    }
    throw new Error('Bloqueado por bot manager en P2 — actualizar COOKIES_BASE');
  }

  vs = updateVSFromAsync(r2.data, vs);
  const redirected = r2.data.includes('muestra_nombres') || r2.data.includes('pageRedirect');
  console.log(`[P2] ✅ | redirected=${redirected} | VS length=${vs.__VIEWSTATE.length}`);

  // Delay humano
  await new Promise(r => setTimeout(r, 300 + Math.random() * 500));

  // P3: GET muestra_nombres
  console.log(`\n--- P3: GET muestra_nombres ---`);
  const r3 = await httpGet(`${BASE}/chc/muestra_nombres.aspx`, jar, `${BASE}/chc/consulta_nombres.aspx`);

  if (isBotBlock(r3.data || '')) {
    if (intento < 3) {
      console.warn(`[TSE-NOM] ⚠️ Bot block en P3, reintentando...`);
      await new Promise(r => setTimeout(r, 2500));
      return consultaNombre(nombre, apellido1, apellido2, intento + 1);
    }
    throw new Error('Bloqueado por bot manager en P3 — actualizar COOKIES_BASE');
  }

  if (r3.status !== 200) {
    console.error(`[P3] STATUS inesperado: ${r3.status}`);
    throw new Error(`HTTP ${r3.status} en muestra_nombres`);
  }

  if (r3.data.includes('error_trans') || r3.data.includes('No se encontraron')) {
    throw new Error('Sin resultados para la búsqueda');
  }

  const { personas, paginacion } = parseMuestra(r3.data);
  console.log(`[P3] ✅ Personas encontradas: ${personas.length}`);
  if (personas.length > 0) console.log(`[P3] Primero: ${JSON.stringify(personas[0])}`);

  return { personas, paginacion, total: personas.length };
}

// ════════════════════════════════════════════════════════════
// RUTAS
// ════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    estado: true,
    mensaje: 'TSE Costa Rica - API Nombres v2',
    uso: [
      'GET /api/nombre?nombre=MARCELA&ap1=CASCANTE&ap2=CHACON',
      'GET /api/nombre?nombre=JUAN&ap1=PEREZ',
      '(ap2 es opcional)',
    ],
  });
});

app.get('/api/nombre', async (req, res) => {
  const { nombre, ap1, apellido1, ap2, apellido2 } = req.query;

  const n  = (nombre          || '').trim();
  const a1 = (ap1 || apellido1 || '').trim();
  const a2 = (ap2 || apellido2 || '').trim();

  if (!n || !a1) {
    return res.status(400).json({
      estado:  false,
      mensaje: 'Parámetros requeridos: ?nombre=JUAN&ap1=PEREZ (ap2 opcional)',
    });
  }

  const soloLetras = /^[A-Za-záéíóúÁÉÍÓÚñÑüÜ\s]+$/;
  if (!soloLetras.test(n) || !soloLetras.test(a1) || (a2 && !soloLetras.test(a2))) {
    return res.status(400).json({
      estado:  false,
      mensaje: 'Solo letras y espacios permitidos.',
    });
  }

  console.log(`\n[API] /api/nombre nombre="${n}" ap1="${a1}" ap2="${a2}"`);
  const t = Date.now();

  try {
    const datos = await consultaNombre(n, a1, a2);
    res.json({
      estado:    true,
      tiempo_ms: Date.now() - t,
      busqueda: {
        nombre:    n.toUpperCase(),
        apellido1: a1.toUpperCase(),
        apellido2: a2.toUpperCase() || null,
      },
      total:      datos.total,
      paginacion: datos.paginacion,
      personas:   datos.personas,
    });
  } catch (e) {
    console.error('[API] ❌', e.message);
    const noRes = e.message.toLowerCase().includes('sin resultados');
    res.status(noRes ? 404 : 500).json({ estado: false, mensaje: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TSE Nombres API v2 en puerto ${PORT}`);
  console.log(`   Prueba: http://localhost:${PORT}/api/nombre?nombre=MARCELA&ap1=CASCANTE&ap2=CHACON`);
});
