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
// ── LOS LOCALES QUE PUBLICAN ──
//
// Chacras cerró el 31/08/2026. El vendor queda declarado porque la tabla y
// el estado publicado todavía lo nombran, pero se ignora salvo que alguien
// ponga PEYA_BV3_ACTIVO=1 a propósito.
//
// Sin esta guarda alcanzaba con que la variable PEYA_VENDOR_BV3 siguiera
// cargada en Railway para que el servicio intentara publicar el stock de un
// local que no existe — y ese stock hoy está en cero, así que habría
// desactivado productos en una tienda que ni siquiera atiende.
const VENDORS = {
  bv2: process.env.PEYA_VENDOR_BV2 || null,   // Maipú
  bv3: process.env.PEYA_BV3_ACTIVO === '1'
    ? (process.env.PEYA_VENDOR_BV3 || null)
    : null,                                    // Chacras · cerrado
};

const INTERVALO_MIN     = parseInt(process.env.INTERVALO_MIN || '12', 10);
const HORA_FULL         = parseInt(process.env.HORA_FULL || '7', 10);
const MODO_PRECIOS      = (process.env.MODO_PRECIOS || 'off').toLowerCase();
const MAX_CAMBIO_PCT    = parseFloat(process.env.MAX_CAMBIO_PCT || '35');   // 0 = sin freno
const ENVIAR_MAX_PEDIDO = (process.env.ENVIAR_MAX_POR_PEDIDO || 'on').toLowerCase() === 'on';
const ADMIN_TOKEN       = process.env.ADMIN_TOKEN || '';
const TZ_OFFSET_HORAS   = -3;

// ── EL MARKUP ──
//
// Se le suma al precio de mostrador para armar el de PedidosYa.
//
// ── LA CUENTA COMPLETA, PORQUE EL NÚMERO ENGAÑA ──
//
// PedidosYa se lleva el 35%. Y el precio de mostrador ya tiene 50% sobre el
// costo con IVA, o sea que el costo es 0,667 del precio.
//
//   markup 20% → cobrás 1,20 P → te queda 0,780 P → +17% sobre el costo
//   markup  7% → cobrás 1,07 P → te queda 0,696 P →  +4,4%
//   markup  5% → cobrás 1,05 P → te queda 0,683 P →  +2,4%
//   markup 2,6%                                    →     0%  ← equilibrio
//
// Con 7% el canal deja poco y es a propósito: la apuesta es reconocimiento
// y rotación, no margen. Pero que sea una decisión tomada con el número
// adelante y no una sorpresa cuando el panel muestre el canal en cero.
//
// Los cuatro niveles quedan porque la tabla los usa, pero todos en 7%: hoy
// no hay motivo para cobrar distinto según el origen del producto. Si algún
// día vuelve a haberlo, se cambia por variable de entorno sin deploy.
const MARKUP_BASE = parseFloat(process.env.MARKUP_PEYA || '0.07');

const MARKUP = {
  privada:     parseFloat(process.env.MARKUP_PRIVADA     || String(MARKUP_BASE)),
  condimentos: parseFloat(process.env.MARKUP_CONDIMENTOS || String(MARKUP_BASE)),
  regional:    parseFloat(process.env.MARKUP_REGIONAL    || String(MARKUP_BASE)),
  nacional:    parseFloat(process.env.MARKUP_NACIONAL    || String(MARKUP_BASE)),
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
// LA VENTA DEL MOSTRADOR LLEGA EN SEGUNDOS
//
// ── EL PROBLEMA ──
//
// El ciclo normal corre cada 7 minutos. Con el umbral en 1, un producto con
// una sola unidad se publica — y si esa unidad se vende en el mostrador,
// hasta 7 minutos después sigue disponible en PedidosYa. Alguien lo pide,
// Lucas va a buscarlo y no está.
//
// Bajar el ciclo no lo resuelve: por más que corra cada minuto, la ventana
// existe igual. Lo que la cierra es reaccionar a la venta.
//
// ── POR QUÉ EL SERVICIO PREGUNTA EN VEZ DE QUE CYRON AVISE ──
//
// Lo directo sería que el POS llame a /sync al cobrar. Dos problemas:
//
//   · el token de admin quedaría en el navegador de cada vendedor
//   · y una llamada de red entraría al camino de una venta. Si PedidosYa
//     tarda tres segundos, el vendedor espera tres segundos con el cliente
//     enfrente. Nada que no sea cobrar puede meterse ahí.
//
// Así, el POS no sabe que esto existe. El servicio hace una consulta chica
// cada 20 segundos —solo el id y la fecha de las ventas nuevas— y recién si
// hubo alguna que toque un producto publicado, sincroniza.
//
// ── LO QUE CUESTA ──
//
// 4.320 consultas por día que en su mayoría no devuelven nada. Es una
// lectura por índice sobre created_at: cuesta menos que un ciclo completo.
// Y a PedidosYa no le llega nada extra: el filtro de deltas ya se encarga
// de que solo viaje lo que cambió.
const VENTAS_CADA_SEG = parseInt(process.env.VENTAS_CADA_SEG || '20', 10);

// Desde cuándo mirar. Arranca en "ahora": las ventas de antes de que el
// servicio levantara ya están reflejadas en el último ciclo completo.
let ultimaVentaVista = new Date().toISOString();
let skusPublicados = null;
let skusPublicadosAt = 0;

// Los producto_id que están publicados en PedidosYa. Se cachean 5 minutos:
// sin esto, cada chequeo traería 490 filas para descartarlas casi siempre.
async function productosPublicados() {
  if (skusPublicados && Date.now() - skusPublicadosAt < 5 * 60 * 1000) return skusPublicados;
  try {
    const filas = await traerTodo('peya_catalogo', 'producto_id',
      q => q.eq('publicado_bv2', true).eq('pausado_manual', false));
    skusPublicados = new Set(filas.map(f => f.producto_id).filter(Boolean));
    skusPublicadosAt = Date.now();
  } catch (e) {
    log('✗ no se pudo leer qué está publicado:', e.message);
    // Sin la lista se asume que cualquier venta importa. Sincronizar de más
    // es barato; no sincronizar cuando hacía falta es un pedido perdido.
    skusPublicados = null;
  }
  return skusPublicados;
}

async function revisarVentas() {
  if (corriendo) return;   // ya hay un ciclo andando: la venta entra en ese
  try {
    const { data, error } = await sb
      .from('ventas_pos')
      .select('id, created_at, items')
      .eq('sucursal_id', 'bv2')
      .eq('cancelada', false)
      .gt('created_at', ultimaVentaVista)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) { log('✗ revisar ventas:', error.message); return; }
    if (!data || !data.length) return;

    // Se avanza la marca SIEMPRE, aunque después se decida no sincronizar.
    // Si no, una venta de algo que no está en PedidosYa haría que se
    // revisara la misma venta cada 20 segundos para siempre.
    ultimaVentaVista = data[data.length - 1].created_at;

    const publicados = await productosPublicados();
    let toca = !publicados;   // sin lista, se sincroniza por las dudas

    if (publicados) {
      for (const v of data) {
        for (const it of (v.items || [])) {
          if (publicados.has(Number(it.producto_id))) { toca = true; break; }
        }
        if (toca) break;
      }
    }

    if (!toca) return;   // se vendió, pero nada que esté en PedidosYa

    log(`· ${data.length} venta(s) en el mostrador — sincronizando`);
    await sincronizar(false);
  } catch (e) {
    // Nunca puede tumbar el servicio: el ciclo normal sigue corriendo.
    log('✗ revisar ventas:', e.message);
  }
}

if (VENTAS_CADA_SEG > 0) {
  setInterval(revisarVentas, VENTAS_CADA_SEG * 1000);
}

const autorizado = req => !ADMIN_TOKEN || req.get('x-admin-token') === ADMIN_TOKEN;

// ═══════════════════════════════════════════════════════════════
// SONDA DE PEDIDOS  ·  SOLO LECTURA
//
// No escribe en la base ni le manda nada a PedidosYa. Su único trabajo
// es contestar dos preguntas que no se pueden responder leyendo la
// documentación:
//
//   1. ¿La credencial que ya tenemos (la del catálogo) sirve también
//      para leer pedidos, o hace falta habilitar algo más?
//
//   2. ¿Los pedidos aparecen apenas entran, o recién una vez que el
//      repartidor los levantó? De eso depende si Lucas puede tenerlos
//      preparados antes de que llegue el repartidor, que es todo el
//      punto de esto.
//
// Usa la MISMA autenticación y el mismo manejo de 401 que el catálogo,
// así que si el catálogo funciona, acá lo único que puede fallar es el
// permiso sobre el endpoint de órdenes — que es justo lo que queremos
// averiguar.
// ═══════════════════════════════════════════════════════════════

// Los pedidos traen datos personales del cliente (teléfono, dirección,
// nombre). Nada de eso hace falta para decidir la integración y no
// tiene por qué salir del servidor: se recorta antes de devolver nada.
const CAMPOS_PERSONALES = /^(phone|mobile|telephone|email|address|street|customer|client|first_name|last_name|full_name|name_?surname|door|apartment|latitude|longitude|coordinates|notes|comment)$/i;

function taparPersonales(valor, profundidad = 0) {
  if (valor === null || valor === undefined || profundidad > 6) return valor;
  if (Array.isArray(valor)) return valor.map(v => taparPersonales(v, profundidad + 1));
  if (typeof valor !== 'object') return valor;
  const salida = {};
  for (const [k, v] of Object.entries(valor)) {
    if (CAMPOS_PERSONALES.test(k)) {
      // Se conserva el tipo y si venía con algo, para saber que el campo
      // existe, pero no su contenido.
      salida[k] = v === null || v === '' ? v : '«tapado»';
    } else {
      salida[k] = taparPersonales(v, profundidad + 1);
    }
  }
  return salida;
}

async function pedirPedidos(vendor, desde, hasta, pagina = 1, porPagina = 20) {
  // La ruta correcta lleva /orders al final. La documentación la muestra
  // sin eso y devuelve 404 mudo; se confirmó probando las variantes con
  // /probar-rutas, y el catálogo sirvió de control para descartar que
  // fueran las credenciales.
  const url = `${PEYA_BASE}/chains/${PEYA_CHAIN}/vendors/${VENDORS[vendor]}/orders`
    + `?start_time=${encodeURIComponent(desde)}&end_time=${encodeURIComponent(hasta)}`
    + `&page_size=${porPagina}&page=${pagina}`;

  const traer = async token => {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, ok: r.ok, cuerpo: await r.text() };
  };

  let r = await traer(await obtenerToken());
  // Mismo criterio que el catálogo: un 401 puede ser el token vencido
  // antes de tiempo. Se pide uno nuevo y se reintenta una sola vez.
  if (r.status === 401) {
    TOKEN_CACHE = { valor: null, vence: 0 };
    r = await traer(await obtenerToken());
  }
  return { url, ...r };
}

// GET /probar-pedidos?horas=24&vendor=bv2
app.get('/probar-pedidos', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: 'no autorizado' });
  if (!PEYA_CHAIN) return res.status(500).json({ error: 'falta PEYA_CHAIN_ID' });

  const horas = Math.min(parseInt(req.query.horas || '24', 10) || 24, 24 * 60);
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - horas * 3600 * 1000);
  const iso = d => d.toISOString().slice(0, 19); // la API los quiere en UTC, sin la Z

  const vendors = req.query.vendor ? [req.query.vendor] : Object.keys(VENDORS).filter(v => VENDORS[v]);
  const salida = { ventana: { desde: iso(desde), hasta: iso(hasta), horas }, vendors: {} };

  for (const v of vendors) {
    if (!VENDORS[v]) { salida.vendors[v] = { error: 'sin vendor_id configurado' }; continue; }
    try {
      const r = await pedirPedidos(v, iso(desde), iso(hasta));
      let cuerpo;
      try { cuerpo = JSON.parse(r.cuerpo); } catch { cuerpo = r.cuerpo.slice(0, 800); }

      // La respuesta puede venir como array o envuelta en un objeto; se
      // contemplan las dos formas sin asumir cuál es.
      const lista = Array.isArray(cuerpo) ? cuerpo
        : (cuerpo && (cuerpo.orders || cuerpo.data || cuerpo.items || cuerpo.content)) || null;

      salida.vendors[v] = {
        http: r.status,
        ok: r.ok,
        cantidad: Array.isArray(lista) ? lista.length : null,
        // Con page_size=20, total_pages dice cuántos pedidos hay en
        // total en la ventana, más allá de los que trae esta página.
        total_pages: (cuerpo && cuerpo.total_pages !== undefined) ? cuerpo.total_pages : null,
        // Lo que más importa: en qué estado vienen. Si acá aparece
        // RECEIVED, se puede ver el pedido mientras se arma.
        estados: Array.isArray(lista)
          ? lista.map(o => o && (o.status || o.order_status || o.state)).filter(Boolean)
          : null,
        // Un pedido completo, sin datos personales, para poder mapear
        // los campos contra la tabla ops.pedidos.
        muestra: Array.isArray(lista) && lista.length ? taparPersonales(lista[0]) : null,
        // Si falló, el cuerpo crudo dice por qué (401 = sin permiso sobre
        // órdenes, 404 = vendor mal, etc.)
        crudo: r.ok ? undefined : String(r.cuerpo).slice(0, 600),
      };
    } catch (e) {
      salida.vendors[v] = { error: e.message };
    }
  }

  res.json(salida);
});

// ═══════════════════════════════════════════════════════════════
// SONDA DE RUTAS  ·  SOLO LECTURA
//
// La ruta de pedidos que figura en la documentación devuelve 404 con el
// cuerpo vacío. Un "no encontré esa orden" real vendría con un JSON
// explicando; un 404 mudo suele ser una ruta que no existe.
//
// Como el catálogo funciona con el MISMO chain y el MISMO vendor, el
// problema no son las credenciales. Quedan dos explicaciones y hay que
// distinguirlas:
//
//   a) la ruta real es otra (la documentación está abreviada o cambió)
//   b) el servicio de órdenes no está habilitado para esta cadena
//
// Esto prueba las variantes plausibles de una y devuelve el código de
// cada una. Todas son GET: no escriben nada ni en PedidosYa ni acá.
//
// Cómo leer el resultado:
//   · alguna da 200          → esa es la ruta buena, seguimos
//   · todas 404 mudas        → la API de órdenes no está habilitada,
//                              hay que pedírsela al Account Manager
//   · alguna da 401 o 403    → la ruta existe pero falta permiso, que
//                              también se pide, pero es otra conversación
// ═══════════════════════════════════════════════════════════════

// GET /probar-rutas?vendor=bv2&horas=48
app.get('/probar-rutas', async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: 'no autorizado' });
  if (!PEYA_CHAIN) return res.status(500).json({ error: 'falta PEYA_CHAIN_ID' });

  const vendor = req.query.vendor || Object.keys(VENDORS).find(v => VENDORS[v]);
  const vid = VENDORS[vendor];
  if (!vid) return res.status(400).json({ error: `sin vendor_id para ${vendor}` });

  const horas = Math.min(parseInt(req.query.horas || '48', 10) || 48, 24 * 60);
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - horas * 3600 * 1000);
  const sinZ = d => d.toISOString().slice(0, 19);
  const conZ = d => d.toISOString();
  const rango    = `start_time=${encodeURIComponent(sinZ(desde))}&end_time=${encodeURIComponent(sinZ(hasta))}`;
  const rangoZ   = `start_time=${encodeURIComponent(conZ(desde))}&end_time=${encodeURIComponent(conZ(hasta))}`;

  const candidatas = [
    ['doc · vendors/{id} con rango',        `/chains/${PEYA_CHAIN}/vendors/${vid}?${rango}`],
    ['vendors/{id}/orders',                 `/chains/${PEYA_CHAIN}/vendors/${vid}/orders?${rango}`],
    ['vendors/{id} sin rango',              `/chains/${PEYA_CHAIN}/vendors/${vid}`],
    ['vendors/{id} con fechas en formato Z',`/chains/${PEYA_CHAIN}/vendors/${vid}?${rangoZ}`],
    ['orders bajo la cadena',               `/chains/${PEYA_CHAIN}/orders?vendor_id=${vid}&${rango}`],
    ['orders sueltas',                      `/orders?chain_id=${PEYA_CHAIN}&vendor_id=${vid}&${rango}`],
    ['catálogo (control: tiene que andar)', `/chains/${PEYA_CHAIN}/vendors/${vid}/catalog`],
  ];

  const token = await obtenerToken();
  const salida = { vendor, vendor_id: vid, chain: PEYA_CHAIN, pruebas: [] };

  for (const [nombre, ruta] of candidatas) {
    try {
      const r = await fetch(`${PEYA_BASE}${ruta}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(20000),
      });
      const cuerpo = (await r.text()) || '';
      salida.pruebas.push({
        prueba: nombre,
        ruta,                       // sin dominio ni token: se puede compartir
        http: r.status,
        cuerpo_vacio: cuerpo.length === 0,
        // Recortado y sin datos personales: solo queremos ver la forma
        // de la respuesta y el mensaje de error si lo hay.
        asoma: taparPersonales(
          (() => { try { return JSON.parse(cuerpo); } catch { return cuerpo.slice(0, 300); } })()
        ),
      });
    } catch (e) {
      salida.pruebas.push({ prueba: nombre, ruta, error: e.message });
    }
  }

  // Resumen en una línea, para no tener que leer todo el detalle
  const buenas = salida.pruebas.filter(p => p.http >= 200 && p.http < 300 && !/catálogo/.test(p.prueba));
  salida.veredicto = buenas.length
    ? `La ruta que funciona es: ${buenas.map(p => p.prueba).join(', ')}`
    : 'Ninguna ruta de pedidos responde. Muy probablemente la API de órdenes no esté habilitada para esta cadena.';

  res.json(salida);
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════
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
  log(`belavita-peya-catalogo v2 · puerto ${PORT} · ciclo ${INTERVALO_MIN} min · ` +
      `ventas cada ${VENTAS_CADA_SEG}s · precios ${MODO_PRECIOS} · freno ${MAX_CAMBIO_PCT}%`);
  sincronizar(false);
});
