// Monitor de citas DIAN: abre la página, sigue los pasos hasta "Devoluciones"
// y avisa cuando aparece la lista de trámites (o sea, cuando hay citas).
// No llena datos ni agenda: eso lo hace la persona al recibir el aviso.
const { chromium } = require("playwright");
const fs = require("fs");

// ================== CONFIGURACIÓN (lo único que se edita) ==================
const URL = process.env.URL_DIAN || "https://agendamiento.dian.gov.co/";

// Textos de los botones en los que se hace clic, EN ORDEN.
const PASOS = [
  "Agendar cita",
  "Persona Natural",
  "Videoatención",
  "Devoluciones",
];

// Texto que muestra la página cuando NO hay citas.
const SIN_CITAS = "No se encontraron especialidades";
// ===========================================================================

const registro = [];
function anotar(mensaje) {
  console.log(mensaje);
  registro.push(mensaje);
}

// Deja anotado el resultado de esta consulta para el registro histórico.
function registrar(estado, detalle, conCaptura) {
  const ahora = new Date();
  const colombia = ahora.toLocaleString("sv-SE", { timeZone: "America/Bogota" });
  const utc = ahora.toISOString().replace(/\.\d+Z$/, "Z");
  const limpio = String(detalle || "").replace(/[;\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  const captura = conCaptura ? colombia.replace(" ", "_").replace(/:/g, "") + ".png" : "";
  fs.writeFileSync("linea.csv", [colombia, estado, limpio, utc, captura].join(";") + "\n");
}

// Envía el aviso por los canales que estén configurados (WhatsApp y/o ntfy).
async function avisar(texto) {
  const tel = process.env.WHATSAPP_PHONE;
  const key = process.env.WHATSAPP_APIKEY;
  const tema = process.env.NTFY_TOPIC;
  if (!(tel && key) && !tema) {
    anotar("No hay ningún canal de aviso configurado todavía; no se envió el mensaje.");
    return;
  }
  if (tel && key) {
    const url =
      "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(tel) +
      "&text=" + encodeURIComponent(texto) +
      "&apikey=" + encodeURIComponent(key);
    try {
      const r = await fetch(url);
      anotar("WhatsApp enviado. Respuesta del servicio: " + r.status);
    } catch (e) {
      anotar("No se pudo enviar el WhatsApp: " + e.message);
    }
  }
  if (tema) {
    try {
      const r = await fetch("https://ntfy.sh/" + encodeURIComponent(tema), {
        method: "POST",
        body: texto,
        headers: { Title: "Citas DIAN", Priority: "urgent", Tags: "rotating_light", Click: URL },
      });
      anotar("Notificación ntfy enviada. Respuesta del servicio: " + r.status);
    } catch (e) {
      anotar("No se pudo enviar la notificación ntfy: " + e.message);
    }
  }
}

// Se ejecuta dentro de la página: busca el botón visible cuyo texto coincide,
// ignorando tildes, mayúsculas, espacios y saltos de línea.
function buscarBoton(texto) {
  const norm = (s) =>
    (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "").toLowerCase();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(e);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const objetivo = norm(texto);
  let exacto = null;
  let parcial = null;
  let largo = Infinity;
  for (const e of document.querySelectorAll("body *")) {
    const etiqueta = e.tagName;
    if (etiqueta === "SCRIPT" || etiqueta === "STYLE" || etiqueta === "OPTION" || etiqueta === "SELECT") continue;
    if (!norm(e.textContent).includes(objetivo)) continue;
    if (!visible(e)) continue;
    const txt = norm(e.innerText);
    if (!txt.includes(objetivo)) continue;
    if (txt === objetivo) {
      if (!exacto || exacto.contains(e)) exacto = e;
    } else if (txt.length < largo && txt.length < 300) {
      parcial = e;
      largo = txt.length;
    }
  }
  const el = exacto || parcial;
  return el ? el.closest(".boton, button, a, [role=button]") || el : null;
}

async function clicEnTexto(page, texto) {
  const limite = Date.now() + 40000;
  while (Date.now() < limite) {
    for (const frame of page.frames()) {
      const dir = frame.url();
      if (dir.includes("recaptcha") || dir === "about:blank") continue;
      const manija = await frame.evaluateHandle(buscarBoton, texto).catch(() => null);
      const el = manija ? manija.asElement() : null;
      if (el) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 15000 });
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('No encontré en pantalla el botón "' + texto + '"');
}

// Se ejecuta dentro de la página: mira si salió el mensaje de "sin citas"
// o si apareció la lista desplegable de trámites.
function leerResultado(textoSinCitas) {
  const norm = (s) =>
    (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "").toLowerCase();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(e);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const objetivo = norm(textoSinCitas);
  let mensaje = "";
  for (const e of document.querySelectorAll("body span, body p, body div, body label, body td")) {
    if (e.children.length > 0) continue;
    if (!norm(e.textContent).includes(objetivo)) continue;
    if (visible(e)) {
      mensaje = (e.innerText || "").trim();
      break;
    }
  }
  let listaVisible = false;
  let opciones = [];
  const zona = document.querySelector('[nombre="Servicios"]');
  const listas = zona ? Array.from(zona.querySelectorAll("select")) : [];
  for (const s of document.querySelectorAll("select")) {
    if (visible(s) && !listas.includes(s)) listas.push(s);
  }
  for (const s of listas) {
    const zonaVisible = visible(s) || (zona && zona.contains(s) && visible(zona));
    if (!zonaVisible) continue;
    listaVisible = true;
    opciones = opciones.concat(
      Array.from(s.options).map((o) => (o.text || "").trim()).filter((t) => t && !/^seleccion/i.test(t))
    );
  }
  return { mensaje, listaVisible, opciones };
}

// Guarda cómo está construida la página, para poder ajustar el bot.
async function guardarDiagnostico(page, motivo) {
  const lineas = ["Motivo: " + motivo, "Dirección: " + page.url(), ""];
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const dir = frames[i].url();
    if (dir.includes("recaptcha") || dir === "about:blank") continue;
    lineas.push("--- Marco " + i + ": " + dir);
    try {
      const info = await frames[i].evaluate(() => {
        const volcar = (raiz) => {
          let salida = "";
          for (const n of raiz.childNodes) {
            if (n.nodeType === 3) salida += n.textContent;
            else if (n.nodeType === 1) {
              const nombre = n.tagName.toLowerCase();
              if (nombre === "script" || nombre === "style") continue;
              const attrs = Array.from(n.attributes)
                .map((a) => " " + a.name + '="' + String(a.value).slice(0, 300) + '"')
                .join("");
              salida += "<" + nombre + attrs + ">";
              if (n.shadowRoot) salida += "<!--sombra-->" + volcar(n.shadowRoot) + "<!--/sombra-->";
              salida += volcar(n) + "</" + nombre + ">";
            }
          }
          return salida;
        };
        return {
          texto: (document.body ? document.body.innerText : "").slice(0, 6000),
          html: volcar(document.documentElement).slice(0, 1500000),
        };
      });
      lineas.push("Texto visible:", info.texto, "");
      fs.writeFileSync("marco-" + i + ".html", info.html);
    } catch (e) {
      lineas.push("No se pudo leer este marco: " + e.message, "");
    }
  }
  lineas.push("--- Registro", ...registro);
  fs.writeFileSync("diagnostico.txt", lineas.join("\n"));
}

(async () => {
  const manual = process.env.MANUAL === "true";
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const context = await browser.newContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  let codigo = 0;

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "paso-0-inicio.png", fullPage: true });

    for (let i = 0; i < PASOS.length; i++) {
      await clicEnTexto(page, PASOS[i]);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await page.screenshot({ path: "paso-" + (i + 1) + ".png", fullPage: true });
      anotar("Paso " + (i + 1) + " listo: " + PASOS[i]);
    }

    // Espera a que la página responda: mensaje de sin citas o lista de trámites.
    let resultado = { mensaje: "", listaVisible: false, opciones: [] };
    const limite = Date.now() + 25000;
    while (Date.now() < limite) {
      resultado = await page.evaluate(leerResultado, SIN_CITAS);
      if (resultado.mensaje || resultado.listaVisible) break;
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: "resultado.png", fullPage: true });
    anotar("Resultado: " + JSON.stringify(resultado));

    if (resultado.mensaje) {
      anotar("Sin citas por ahora.");
      registrar("sin_citas", resultado.mensaje, false);
      if (manual) await avisar("Prueba del bot DIAN: funciona. Por ahora NO hay citas.");
    } else if (resultado.listaVisible) {
      const tramites = resultado.opciones.slice(0, 4).join(", ");
      registrar("hay_citas", tramites ? "Trámites ofrecidos: " + tramites : "Apareció la lista de trámites", true);
      await avisar("DIAN: HAY CITAS (Videoatención - Devoluciones)." + (tramites ? " Trámites: " + tramites + "." : "") + " Entra ya: " + URL);
    } else {
      registrar("no_reconocido", "No salió el mensaje de sin citas ni la lista de trámites", true);
      await avisar("DIAN: no salió el mensaje de sin citas. Revisa por si hay disponibilidad: " + URL);
    }
    if (manual) await guardarDiagnostico(page, "Prueba manual terminada");
  } catch (e) {
    anotar("Error: " + e.message);
    registrar("error", e.message, false);
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    await guardarDiagnostico(page, e.message).catch(() => {});
    if (manual) await avisar("Prueba del bot DIAN: falló. " + e.message);
    codigo = 1;
  } finally {
    await browser.close();
  }
  process.exit(codigo);
})();
