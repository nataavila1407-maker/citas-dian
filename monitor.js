// Monitor de citas DIAN: abre la página, sigue los pasos y avisa por WhatsApp
// si deja de aparecer el mensaje de "no hay citas".
const { chromium } = require("playwright");

// ================== CONFIGURACIÓN (lo único que se edita) ==================
const URL = process.env.URL_DIAN || "https://agendamiento.dian.gov.co/";

// Textos de los botones u opciones en los que haces clic, EN ORDEN y tal como
// se ven en pantalla. Un texto por línea, entre comillas y con coma al final.
const PASOS = [
  "Persona Natural",
  "Videoatención",
  "Devoluciones",
];

// Texto que muestra la página cuando NO hay citas.
const SIN_CITAS = "No se encontraron especialidades";
// ===========================================================================

async function whatsapp(texto) {
  const tel = process.env.WHATSAPP_PHONE;
  const key = process.env.WHATSAPP_APIKEY;
  if (!tel || !key) {
    console.log("Faltan los secretos WHATSAPP_PHONE o WHATSAPP_APIKEY; no se envió el mensaje.");
    return;
  }
  const url =
    "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(tel) +
    "&text=" + encodeURIComponent(texto) +
    "&apikey=" + encodeURIComponent(key);
  try {
    const r = await fetch(url);
    console.log("WhatsApp enviado. Respuesta del servicio:", r.status);
  } catch (e) {
    console.log("No se pudo enviar el WhatsApp:", e.message);
  }
}

// Busca un texto visible (en la página o en marcos internos) y hace clic.
// Si el texto es una opción de una lista desplegable, la selecciona.
async function clicEnTexto(page, texto) {
  const limite = Date.now() + 25000;
  while (Date.now() < limite) {
    for (const frame of page.frames()) {
      for (const exacto of [true, false]) {
        const candidatos = frame.getByText(texto, { exact: exacto });
        const n = await candidatos.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const el = candidatos.nth(i);
          if (await el.isVisible().catch(() => false)) {
            await el.click();
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
  throw new Error('No encontré en pantalla el texto "' + texto + '"');
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
    await page.waitForTimeout(4000);
    await page.screenshot({ path: "paso-0-inicio.png", fullPage: true });

    for (let i = 0; i < PASOS.length; i++) {
      await clicEnTexto(page, PASOS[i]);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: "paso-" + (i + 1) + ".png", fullPage: true });
      console.log("Paso " + (i + 1) + " listo: " + PASOS[i]);
    }

    const sinCitas = await apareceTexto(page, SIN_CITAS, 20000);
    await page.screenshot({ path: "resultado.png", fullPage: true });

    if (sinCitas) {
      console.log("Sin citas por ahora.");
      if (manual) await whatsapp("Prueba del bot DIAN: funciona. Por ahora NO hay citas.");
    } else {
      console.log("No apareció el mensaje de sin citas: posible disponibilidad.");
      await whatsapp(
        (manual ? "Prueba del bot DIAN: no vi el mensaje de sin citas. " : "") +
        "DIAN: puede haber CITAS DISPONIBLES (Videoatención - Devoluciones). Entra ya: " + URL
      );
    }
  } catch (e) {
    console.error("Error:", e.message);
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    if (manual) await whatsapp("Prueba del bot DIAN: falló. " + e.message);
    codigo = 1;
  } finally {
    await browser.close();
  }
  process.exit(codigo);
})();
