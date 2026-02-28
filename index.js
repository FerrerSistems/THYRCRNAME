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

// ════════════════════════════════════════════════════════════
// HTTP HELPERS
// ════════════════════════════════════════════════════════════

const BASE = 'https://servicioselectorales.tse.go.cr';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
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

async function httpGet(url, jar, extra = {}) {
  const r = await axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'es-CR,es;q=0.9',
      'Cookie': cookieStr(jar),
      ...extra,
    },
    timeout: 25000,
    validateStatus: s => s < 500,
  });
  parseCookies(r.headers['set-cookie'], jar);
  return r;
}

async function httpPost(url, body, jar, referer) {
  const r = await axios.post(url, body.toString(), {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'es-CR,es;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': referer,
      'Cookie': cookieStr(jar),
    },
    timeout: 25000,
    validateStatus: s => s < 500,
  });
  parseCookies(r.headers['set-cookie'], jar);
  return r;
}

// ════════════════════════════════════════════════════════════
// PARSER — muestra_nombres.aspx
// Los checkboxes tienen labels con formato:
// "N- CEDULA   NOMBRE COMPLETO"
// También hay un DropDownList con value=CEDULA y text=NOMBRE
// ════════════════════════════════════════════════════════════

function parseMuestra(html) {
  const $        = cheerio.load(html);
  const personas = [];

  // Método 1: labels de checkboxes en #chk1
  $('#chk1 label').each((_, el) => {
    const txt = $(el).text().trim();
    // Formato: "1- 113490509   MARCELA DE LOS ANGELES CASCANTE CHACON"
    const m = txt.match(/^\d+[-–]\s*(\d{5,12})\s+(.+)$/);
    if (m) {
      personas.push({
        cedula: m[1].trim(),
        nombre: m[2].replace(/\s+/g, ' ').trim(),
      });
    }
  });

  // Método 2: DropDownList (usado cuando hay resultados) — value=cedula
  if (personas.length === 0) {
    $('select option').each((_, el) => {
      const val = $(el).attr('value') || '';
      const txt = $(el).text().trim();
      if (/^\d{5,12}$/.test(val) && txt) {
        personas.push({ cedula: val, nombre: txt.replace(/\s+/g, ' ').trim() });
      }
    });
  }

  // Método 3: extraer del ViewState serializado (fallback)
  // El ViewState en muestra_nombres contiene los datos en base64 pero
  // también aparecen en texto plano en los inputs hidden
  if (personas.length === 0) {
    // Buscar spans/inputs con patrón de cédula + nombre
    $('span, td, li').each((_, el) => {
      const txt = $(el).text().trim();
      const m   = txt.match(/(\d{9,12})\s{2,}([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ\s]+)/);
      if (m && !personas.find(p => p.cedula === m[1])) {
        personas.push({
          cedula: m[1].trim(),
          nombre: m[2].replace(/\s+/g, ' ').trim(),
        });
      }
    });
  }

  // Paginación
  const paginacion = $('#lblmensajes').text().trim() || null;

  return { personas, paginacion };
}

// ════════════════════════════════════════════════════════════
// CONSULTA POR NOMBRE
// ════════════════════════════════════════════════════════════

async function consultaNombre(nombre, apellido1, apellido2) {
  let jar = {};

  // ── P1: GET consulta_nombres ──────────────────────────────────────────────
  console.log(`[TSE-NOM] P1 GET consulta_nombres`);
  const r1 = await httpGet(`${BASE}/chc/consulta_nombres.aspx`, jar);
  let vs   = extractVS(r1.data);
  if (!vs.__VIEWSTATE) throw new Error('No se obtuvo ViewState de consulta_nombres');

  // ── P2: POST buscar nombre (async) ────────────────────────────────────────
  console.log(`[TSE-NOM] P2 POST nombre="${nombre}" ap1="${apellido1}" ap2="${apellido2}"`);
  const b2 = new URLSearchParams({
    'ScriptManager1':     'UpdatePanel1|btnConsultarNombre',
    '__LASTFOCUS':        '',
    '__EVENTTARGET':      '',
    '__EVENTARGUMENT':    '',
    '__VIEWSTATE':         vs.__VIEWSTATE,
    '__VIEWSTATEGENERATOR':vs.__VIEWSTATEGENERATOR,
    '__EVENTVALIDATION':   vs.__EVENTVALIDATION,
    'txtnombre':           nombre.toUpperCase(),
    'txtapellido1':        apellido1.toUpperCase(),
    'txtapellido2':        apellido2 ? apellido2.toUpperCase() : '',
    'referencia':          '',
    'observacion':         '',
    '__ASYNCPOST':         'true',
    'btnConsultarNombre':  'Consultar',
  });
  const r2 = await httpPost(
    `${BASE}/chc/consulta_nombres.aspx`, b2, jar,
    `${BASE}/chc/consulta_nombres.aspx`
  );
  vs = updateVSFromAsync(r2.data, vs);

  // Verificar si hay redirección a muestra_nombres en el response
  const redirected = r2.data.includes('muestra_nombres') || r2.data.includes('pageRedirect');
  console.log(`[TSE-NOM] P2: redirected=${redirected}`);

  // ── P3: GET muestra_nombres ───────────────────────────────────────────────
  console.log(`[TSE-NOM] P3 GET muestra_nombres`);
  const r3 = await httpGet(
    `${BASE}/chc/muestra_nombres.aspx`, jar,
    { 'Referer': `${BASE}/chc/consulta_nombres.aspx` }
  );

  if (r3.status !== 200 || r3.data.includes('error_trans')) {
    throw new Error('Sin resultados o error en la búsqueda');
  }

  const { personas, paginacion } = parseMuestra(r3.data);
  console.log(`[TSE-NOM] P3: encontrados=${personas.length}`);

  return { personas, paginacion, total: personas.length };
}

// ════════════════════════════════════════════════════════════
// RUTAS
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    estado: true,
    mensaje: 'TSE Costa Rica - API Nombres',
    uso: [
      'GET /api/nombre?nombre=MARCELA&ap1=CASCANTE&ap2=CHACON',
      'GET /api/nombre?nombre=JUAN&ap1=PEREZ',
      '(ap2 es opcional)',
    ],
  });
});

// Ruta principal
app.get('/api/nombre', async (req, res) => {
  const { nombre, ap1, apellido1, ap2, apellido2 } = req.query;

  const n  = (nombre    || '').trim();
  const a1 = (ap1 || apellido1 || '').trim();
  const a2 = (ap2 || apellido2 || '').trim();

  if (!n || !a1) {
    return res.status(400).json({
      estado: false,
      mensaje: 'Parámetros requeridos: ?nombre=JUAN&ap1=PEREZ (ap2 opcional)',
    });
  }

  // Validar solo letras y espacios
  const soloLetras = /^[A-Za-záéíóúÁÉÍÓÚñÑüÜ\s]+$/;
  if (!soloLetras.test(n) || !soloLetras.test(a1) || (a2 && !soloLetras.test(a2))) {
    return res.status(400).json({
      estado: false,
      mensaje: 'Los parámetros deben contener solo letras y espacios.',
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
    const noResultados = e.message.toLowerCase().includes('sin resultados') ||
                         e.message.toLowerCase().includes('error');
    res.status(noResultados ? 404 : 500).json({
      estado:  false,
      mensaje: e.message,
    });
  }
});

// Alias con parámetros en path
app.get('/api/nombre/:nombre/:ap1', async (req, res) => {
  req.query.nombre = req.params.nombre;
  req.query.ap1    = req.params.ap1;
  return app._router.handle(
    Object.assign(req, { url: '/api/nombre', path: '/api/nombre' }), res, () => {}
  );
});

app.listen(PORT, () => {
  console.log(`🚀 TSE Nombres API en puerto ${PORT}`);
  console.log(`   Prueba: http://localhost:${PORT}/api/nombre?nombre=MARCELA&ap1=CASCANTE&ap2=CHACON`);
});
