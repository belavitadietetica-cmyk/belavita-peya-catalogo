// ═══════════════════════════════════════════════════════════════
// BELAVITA · SINCRONIZADOR DE CATÁLOGO CON PEDIDOSYA  (v2)
//
// Mantiene stock Y PRECIOS de Maipú (bv2) y Chacras (bv3) sincronizados
// con PedidosYa, leyendo de ops.productos y ops.stock_sucursal.
//
// ── CAMBIOS DE LA v1, con el motivo ──
//
// 1) AUTENTICACIÓN OAuth 2.0. No hay token fijo: se cargan client_id y
//    client_secret una vez, y con eso se genera un access_token que dura
//    2 horas. Se cachea y se renueva 5 minutos antes de vencer. El
//    endpoint de token tolera 50 llamadas por minuto, así que pedir uno
//    nuevo en cada request sería un error.
//
// 2) SE MANDA `quantity` JUNTO CON `active`. En la v1 mandaba sólo
//    `active` para evitar señales contradictorias. Estaba mal: la tabla
//    oficial de la API no contempla el caso "active=true sin quantity",
//    y el stock de seguridad de la plataforma es de 1 unidad. Mandar los
//    dos de acuerdo (activo → cantidad real; inactivo → 0) es el único
//    camino determinístico.
//
// 3) FRENO DE PRECIOS (MAX_CAMBIO_PCT). Un error de tipeo en el POS
//    ahora viaja solo a una plataforma en vivo en 15 minutos. Cualquier
//    cambio de precio mayor al límite se saltea y queda registrado en el
//    log en vez de publicarse. La primera carga —que legítimamente mueve
//    precios hasta 60%— se hace con el freno desactivado a propósito.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// ── Configuración ──
const SB_URL = process.env.SB_URL;
const SB_KEY = process.env.SB_SERVICE_KEY;

const PEYA_BASE          = process.env.PEYA_BASE || 'https://pedidosya.partner.deliveryhero.io/v2';
const PEYA_CLIENT_ID     = process.env.PEYA_CLIENT_ID;
const PEYA_CLIENT_SECRET = process.env.PEYA_CLIENT_SECRET;
const PEYA_CHAIN         = process.env.PEYA_CHAIN_ID;
const VENDORS = {
  bv2: process.env.PEYA_VENDOR_BV2 || null,   // Maipú
  bv3: process.env.PEYA_VENDOR_BV3 || null,   // Chacras de Coria
};

const INTERVALO_MIN     = parseInt(process.env.INTERVALO_MIN || '12', 10);
const HORA_FULL         = parseInt(process.env.HORA_FULL || '7', 10);
const MODO_PRECIOS      = (process.env.MODO_PRECIOS || 'off').toLowerCase();
const MAX_CAMBIO_PCT    = parseFloat(process.env.MAX_CAMBIO_PCT || '35');   // 0 = sin freno
const ENVIAR_MAX_PEDIDO = (process.env.ENVIAR_MAX_POR_PEDIDO || 'on').toLowerCase() === 'on';
const ADMIN_TOKEN       = process.env.ADMIN_TOKEN || '';
const TZ_OFFSET_HORAS   = -3;

const MARKUP = {
  privada:     parseFloat(process.env.MARKUP_PRIVADA     || '0.15'),
  condimentos: parseFloat(process.env.MARKUP_CONDIMENTOS || '0.25'),
  regional:    parseFloat(process.env.MARKUP_REGIONAL    || '0.22'),
  nacional:    parseFloat(process.env.MARKUP_NACIONAL    || '0.14'),
};

const sb = createClient(SB_URL, SB_KEY, { db: { schema: 'ops' }, auth: { persistSession: false } });
const app = express();
app.use(express.json({ limit: '5mb' }));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const redondear50 = n => Math.max(50, Math.round(n / 50) * 50);
const limpiar = it => { const { _precio_anterior, ...resto } = it; return resto; };

function precioPeya(precioMostrador, nivel) {
  const m = MARKUP[nivel];
  if (!precioMostrador || m === undefined) return null;
  return redondear50(precioMostrador * (1 + m));
}

// ═══════════════════════════════════════════════════════════════
// AUTENTICACIÓN · OAuth 2.0 client credentials
// ═══════════════════════════════════════════════════════════════
let TOKEN_CACHE = { valor: null, vence: 0 };

async function obtenerToken() {
  if (TOKEN_CACHE.valor && Date.now() < TOKEN_CACHE.vence) return TOKEN_CACHE.valor;

  const cuerpo = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: PEYA_CLIENT_ID,
    client_secret: PEYA_CLIENT_SECRET,
  });

  const r = await fetch(`${PEYA_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: cuerpo.toString(),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) {
    const detalle = await r.text();
    throw new Error(`no pude obtener el token (HTTP ${r.status}): ${detalle.slice(0, 300)}`);
  }

  const data = await r.json();
  const segundos = Number(data.expires_in) || 7200;
  TOKEN_CACHE = { valor: data.access_token, vence: Date.now() + (segundos - 300) * 1000 };
  log(`✓ token nuevo · vence en ${Math.round(segundos / 60)} min`);
  return TOKEN_CACHE.valor;
}

// ── Trae TODO paginando (PostgREST corta en 1000 filas sin avisar) ──
async function traerTodo(tabla, columnas, filtro) {
  const PAGE = 1000;
  let desde = 0, todas = [];
  while (true) {
    let q = sb.from(tabla).select(columnas).range(desde, desde + PAGE - 1);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabla}: ${error.message}`);
    todas = todas.concat(data || []);
    if (!data || data.length < PAGE) break;
    desde += PAGE;
  }
  return todas;
}

// ═══════════════════════════════════════════════════════════════
// QUÉ TIENE QUE VER EL CLIENTE EN CADA SUCURSAL
// ═══════════════════════════════════════════════════════════════
async function calcularEstadoDeseado() {
  const catalogo = await traerTodo(
    'peya_catalogo',
    'sku, producto_id, nombre_peya, nivel, max_por_pedido, umbral_stock, publicado_bv2, publicado_bv3, pausado_manual, precio_publicado'
  );

  const conProducto = catalogo.filter(c => c.producto_id);
  const huerfanos = catalogo.length - conProducto.length;
  if (huerfanos) log(`⚠ ${huerfanos} SKU sin producto enganchado — se ignoran`);

  const ids = conProducto.map(c => c.producto_id);
  const productos = await traerTodo('productos', 'id, nombre, precio_venta, activo, se_vende', q => q.in('id', ids));
  const stock     = await traerTodo('stock_sucursal', 'producto_id, sucursal_id, cantidad', q => q.in('producto_id', ids));

  const PROD  = new Map(productos.map(p => [p.id, p]));
  const STOCK = new Map();
  stock.forEach(s => STOCK.set(`${s.producto_id}|${s.sucursal_id}`, Number(s.cantidad) || 0));

  const deseado = { bv2: [], bv3: [] };

  for (const c of conProducto) {
    const p = PROD.get(c.producto_id);
    if (!p) continue;

    for (const suc of ['bv2', 'bv3']) {
      if (!VENDORS[suc]) continue;
      if (suc === 'bv2' && !c.publicado_bv2) continue;
      if (suc === 'bv3' && !c.publicado_bv3) continue;

      const cantidad = STOCK.get(`${c.producto_id}|${suc}`) ?? 0;
      const activo = !!p.activo && p.se_vende !== false && !c.pausado_manual && cantidad >= c.umbral_stock;

      // active y quantity van SIEMPRE juntos y de acuerdo entre sí.
      const item = { sku: c.sku, active: activo, quantity: activo ? cantidad : 0 };
      if (ENVIAR_MAX_PEDIDO) item.maximum_sales_quantity = c.max_por_pedido;

      if (MODO_PRECIOS === 'on') {
        const precio = precioPeya(Number(p.precio_venta), c.nivel);
        if (precio) { item.price = precio; item._precio_anterior = c.precio_publicado; }
      }
      deseado[suc].push(item);
    }
  }
  return deseado;
}

// ── El freno: saca los cambios de precio desmedidos ──
function aplicarFreno(items, sinLimite) {
  if (sinLimite || !MAX_CAMBIO_PCT || MODO_PRECIOS !== 'on') {
    return { pasan: items.map(limpiar), frenados: [] };
  }
  const pasan = [], frenados = [];
  for (const it of items) {
    const antes = Number(it._precio_anterior);
    if (it.price && antes > 0) {
      const cambio = Math.abs(it.price / antes - 1) * 100;
      if (cambio > MAX_CAMBIO_PCT) {
        frenados.push({ sku: it.sku, antes, ahora: it.price, cambio_pct: Math.round(cambio * 10) / 10 });
        const copia = limpiar(it);
        delete copia.price;          // va la disponibilidad, no el precio
        pasan.push(copia);
        continue;
      }
    }
    pasan.push(limpiar(it));
  }
  return { pasan, frenados };
}

// ── Sólo lo que cambió ──
async function filtrarDeltas(vendor, items) {
  const previos = await traerTodo('peya_estado_publicado', 'sku, activo, precio, max_por_pedido, cantidad', q => q.eq('vendor', vendor));
  const ANT = new Map(previos.map(r => [r.sku, r]));
  return items.filter(it => {
    const a = ANT.get(it.sku);
    if (!a) return true;
    if (a.activo !== it.active) return true;
    if (a.cantidad !== it.quantity) return true;
    if (it.maximum_sales_quantity !== undefined && a.max_por_pedido !== it.maximum_sales_quantity) return true;
    if (it.price !== undefined && a.precio !== it.price) return true;
    return false;
  });
}

async function guardarEstado(vendor, items) {
  const filas = items.map(it => ({
    sku: it.sku, vendor,
    activo: it.active,
    cantidad: it.quantity,
    precio: it.price ?? null,
    max_por_pedido: it.maximum_sales_quantity ?? null,
    enviado_at: new Date().toISOString(),
  }));
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await sb.from('peya_estado_publicado').upsert(filas.slice(i, i + 500), { onConflict: 'sku,vendor' });
    if (error) log('⚠ no pude guardar el estado local:', error.message);
  }
  for (const it of items.filter(x => x.price)) {
    await sb.from('peya_catalogo').update({ precio_publicado: it.price }).eq('sku', it.sku);
  }
}

// ═══════════════════════════════════════════════════════════════
// ENVÍO
// ═══════════════════════════════════════════════════════════════
async function put(url, token, items) {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ products: items }),
    signal: AbortSignal.timeout(60000),
  });
  return { status: r.status, ok: r.ok, cuerpo: await r.text() };
}

async function enviarAPeya(vendor, items, tipo) {
  const url = `${PEYA_BASE}/chains/${PEYA_CHAIN}/vendors/${VENDORS[vendor]}/catalog`;
  let httpStatus = null, jobId = null, errorMsg = null;

  try {
    let r = await put(url, await obtenerToken(), items);

    // 401 = el token murió antes de tiempo. Se tira el cache y se
    // reintenta UNA sola vez.
    if (r.status === 401) {
      log('· token rechazado, pido uno nuevo y reintento');
      TOKEN_CACHE = { valor: null, vence: 0 };
      r = await put(url, await obtenerToken(), items);
    }

    httpStatus = r.status;
    if (r.ok) { try { jobId = JSON.parse(r.cuerpo).job_id; } catch { /* sin json */ } }
    else errorMsg = r.cuerpo.slice(0, 500);

    if (errorMsg) log(`✗ ${vendor} ${tipo}: HTTP ${httpStatus} · ${errorMsg}`);
    else log(`✓ ${vendor} ${tipo}: ${items.length} SKU · job ${jobId || '—'}`);
  } catch (e) {
    errorMsg = e.message;
    log(`✗ ${vendor} ${tipo}: ${e.message}`);
  }

  await sb.from('peya_sync_log').insert({
    vendor, tipo, skus: items.length, job_id: jobId, http_status: httpStatus, error: errorMsg,
  });
  return { ok: httpStatus >= 200 && httpStatus < 300, jobId, errorMsg };
}

// ═══════════════════════════════════════════════════════════════
// CICLO
// ═══════════════════════════════════════════════════════════════
let corriendo = false;

async function sincronizar(forzarFull = false, sinLimite = false) {
  if (corriendo) { log('… ya hay una sincronización en curso'); return { saltado: true }; }
  if (!PEYA_CLIENT_ID || !PEYA_CLIENT_SECRET || !PEYA_CHAIN) {
    log('⚠ faltan credenciales de PedidosYa — no sincronizo');
    return { error: 'faltan credenciales' };
  }
  corriendo = true;
  const resumen = {};
  try {
    const deseado = await calcularEstadoDeseado();
    for (const vendor of Object.keys(VENDORS)) {
      if (!VENDORS[vendor]) continue;
      const todos = deseado[vendor] || [];
      if (!todos.length) { resumen[vendor] = 'sin productos'; continue; }

      const candidatos = forzarFull ? todos : await filtrarDeltas(vendor, todos);
      if (!candidatos.length) { log(`· ${vendor}: sin cambios`); resumen[vendor] = 'sin cambios'; continue; }

      const { pasan, frenados } = aplicarFreno(candidatos, sinLimite);
      if (frenados.length) {
        log(`⚠ ${vendor}: ${frenados.length} precios frenados por superar ${MAX_CAMBIO_PCT}%`);
        await sb.from('peya_sync_log').insert({
          vendor, tipo: 'frenado', skus: frenados.length,
          error: JSON.stringify(frenados).slice(0, 2000),
        });
      }

      const r = await enviarAPeya(vendor, pasan, forzarFull ? 'full' : 'delta');
      if (r.ok) await guardarEstado(vendor, pasan);
      resumen[vendor] = { enviados: r.ok ? pasan.length : 0, frenados: frenados.length, error: r.errorMsg || null };
    }
  } catch (e) {
    log('✗ error general:', e.message);
    resumen.error = e.message;
  } finally {
    corriendo = false;
  }
  return resumen;
}

let ultimoFull = null;
function tocaFull() {
  const ahora = new Date(Date.now() + TZ_OFFSET_HORAS * 3600 * 1000);
  const hoy = ahora.toISOString().slice(0, 10);
  if (ahora.getUTCHours() === HORA_FULL && ultimoFull !== hoy) { ultimoFull = hoy; return true; }
  return false;
}
setInterval(() => sincronizar(tocaFull()), INTERVALO_MIN * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════
const autorizado = req => !ADMIN_TOKEN || req.get('x-admin-token') === ADMIN_TOKEN;

app.get('/health', (_req, res) => res.json({
  ok: true,
  credenciales: PEYA_CLIENT_ID && PEYA_CLIENT_SECRET ? 'cargadas' : 'faltan',
  vendors: Object.fromEntries(Object.entries(VENDORS).map(([k, v]) => [k, v ? 'ok' : 'falta'])),
  modo_precios: MODO_PRECIOS,
  freno_pct: MAX_CAMBIO_PCT || 'sin freno',
  intervalo_min: INTERVALO_MIN,
}));

// Prueba las credenciales solas, sin tocar el catálogo
app.get('/probar-credenciales', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: 'no autorizado' });
  try {
    TOKEN_CACHE = { valor: null, vence: 0 };
    const t = await obtenerToken();
    res.json({ ok: true, token: t.slice(0, 12) + '…', vence_en_min: Math.round((TOKEN_CACHE.vence - Date.now()) / 60000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simulacro: calcula todo, no manda nada
app.get('/simulacro', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: 'no autorizado' });
  try {
    const deseado = await calcularEstadoDeseado();
    const resumen = {};
    for (const [v, items] of Object.entries(deseado)) {
      const { frenados } = aplicarFreno(items, false);
      resumen[v] = {
        total: items.length,
        activos: items.filter(i => i.active).length,
        inactivos: items.filter(i => !i.active).length,
        precios_que_frenaria: frenados.length,
        frenados: frenados.slice(0, 20),
        muestra: items.slice(0, 10).map(limpiar),
      };
    }
    res.json(resumen);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /sync?full=1&sin_limite=1
app.post('/sync', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: 'no autorizado' });
  const resumen = await sincronizar(req.query.full === '1', req.query.sin_limite === '1');
  res.json({ ok: true, resumen });
});

app.post('/webhook/catalogo', async (req, res) => {
  log('webhook catálogo:', JSON.stringify(req.body).slice(0, 800));
  await sb.from('peya_sync_log').insert({
    vendor: 'webhook', tipo: 'respuesta',
    job_id: req.body?.job_id || null,
    error: req.body?.status && req.body.status !== 'COMPLETED' ? JSON.stringify(req.body).slice(0, 2000) : null,
  });
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`belavita-peya-catalogo v2 · puerto ${PORT} · ciclo ${INTERVALO_MIN} min · precios ${MODO_PRECIOS} · freno ${MAX_CAMBIO_PCT}%`);
  sincronizar(false);
});
