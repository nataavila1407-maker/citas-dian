// Monitor de citas DIAN: abre la página, sigue los pasos y avisa por WhatsApp
// si deja de aparecer el mensaje de "no hay citas".
const { chromium } = require("playwright");
const fs = require("fs");

// ================== CONFIGURACIÓN (lo único que se edita) ==================
const URL = process.env.URL_DIAN || "https://agendamiento.dian.gov.co/";

// Textos de los botones u opciones en los que haces clic, EN ORDEN y tal como
// se ven en pantalla. Un texto por línea, entre comillas y con coma al final.
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

async function whatsapp(texto) {
  const tel = process.env.WHATSAPP_PHONE;
  const key = process.env.WHATSAPP_APIKEY;
  if (!tel || !key) {
    anotar("Faltan los secretos WHATSAPP_PHONE o WHATSAPP_APIKEY; no se envió el mensaje.");
    return;
  }
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

// Busca un texto visible (en la página o en marcos internos) y hace clic.
// Si el texto es una opción de una lista desplegable, la selecciona.
async function clicEnTexto(page, texto) {
  const limite = Date.now() + 30000;
  let vistos = 0;
  while (Date.now() < limite) {
    for (const frame of page.frames()) {
      const grupos = [
        frame.getByText(texto, { exact: true }),
        frame.getByText(texto, { exact: false }),
        frame.locator(
          '[value="' + texto + '" i], [aria-label*="' + texto + '" i], ' +
          '[title*="' + texto + '" i], [alt*="' + texto + '" i]'
        ),
      ];
      for (const candidatos of grupos) {
        const n = await candidatos.count().catch(() => 0);
        vistos = Math.max(vistos, n);
        for (let i = 0; i < n; i++) {
          const el = candidatos.nth(i);
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 10000 });
            return;
          }
        }
      }
      // Lista desplegable clásica: se selecciona la opción en vez de hacer clic.
      const opcion = frame.locator("select:visible option", { hasText: texto }).first();
      if ((await opcion.count().catch(() => 0)) > 0) {
        const nombre = ((await opcion.textContent()) || "").trim();
        await opcion.locator("xpath=..").selectOption({ label: nombre });
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    'No encontré en pantalla el texto "' + texto + '" (coincidencias ocultas: ' + vistos + ")"
  );
}

async function apareceTexto(page, texto, ms) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    for (const frame of page.frames()) {
      const visible = await frame.getByText(texto).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// Guarda cómo está construida la página, para poder ajustar el bot.
async function guardarDiagnostico(page, motivo) {
  const lineas = ["Motivo: " + motivo, "Dirección: " + page.url(), ""];
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    lineas.push("--- Marco " + i + ": " + frames[i].url());
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
        const todos = Array.from(document.querySelectorAll("*"));
        return {
          resumen: {
            lienzos: document.querySelectorAll("canvas").length,
            marcos: document.querySelectorAll("iframe, frame, object, embed").length,
            conSombra: todos.filter((e) => e.shadowRoot).length,
            etiquetasPropias: Array.from(
              new Set(todos.map((e) => e.tagName.toLowerCase()).filter((t) => t.includes("-")))
            ).slice(0, 60),
          },
          texto: (document.body ? document.body.innerText : "").slice(0, 6000),
          html: volcar(document.documentElement).slice(0, 1500000),
        };
      });
      lineas.push(JSON.stringify(info.resumen), "Texto visible:", info.texto, "");
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
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "paso-0-inicio.png", fullPage: true });

    for (let i = 0; i < PASOS.length; i++) {
      await clicEnTexto(page, PASOS[i]);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await page.screenshot({ path: "paso-" + (i + 1) + ".png", fullPage: true });
      anotar("Paso " + (i + 1) + " listo: " + PASOS[i]);
    }

    const sinCitas = await apareceTexto(page, SIN_CITAS, 20000);
    await page.screenshot({ path: "resultado.png", fullPage: true });

    if (sinCitas) {
      anotar("Sin citas por ahora.");
      if (manual) await whatsapp("Prueba del bot DIAN: funciona. Por ahora NO hay citas.");
    } else {
      anotar("No apareció el mensaje de sin citas: posible disponibilidad.");
      await whatsapp(
        (manual ? "Prueba del bot DIAN: no vi el mensaje de sin citas. " : "") +
        "DIAN: puede haber CITAS DISPONIBLES (Videoatención - Devoluciones). Entra ya: " + URL
      );
    }
    if (manual) await guardarDiagnostico(page, "Prueba manual terminada");
  } catch (e) {
    anotar("Error: " + e.message);
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    await guardarDiagnostico(page, e.message).catch(() => {});
    if (manual) await whatsapp("Prueba del bot DIAN: falló. " + e.message);
    codigo = 1;
  } finally {
    await browser.close();
  }
  process.exit(codigo);
})();
