// ============================================================================
//  Edge Function : invite-client
//  Crée (ou retrouve) le compte d'un client, lui envoie SES IDENTIFIANTS par
//  e-mail (identifiant + mot de passe provisoire, via Brevo) et le relie à
//  son dossier. Appelée par le logiciel du cabinet.
//
//  Déploiement : supabase functions deploy invite-client
//  Variables (Project Settings › Edge Functions › Secrets) :
//    PORTAL_URL_CLIENT = https://anouarmt.github.io/fidinfocom/portail-client.html
//    SMTP_LOGIN        = ae9f28001@smtp-brevo.com   (Settings > SMTP et API > SMTP, dans Brevo)
//    SMTP_KEY          = valeur complète de votre clé SMTP Brevo
//    MAIL_FROM_EMAIL   = expéditeur vérifié dans Brevo (ex. anouarmtougui@gmail.com)
//    MAIL_FROM_NAME    = fid info com
//  (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement)
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function genPassword(len = 12): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function esc(s: string) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

async function sendMail(to: string, subject: string, html: string, text: string) {
  const login = Deno.env.get("SMTP_LOGIN");
  const key = Deno.env.get("SMTP_KEY");
  const fromEmail = Deno.env.get("MAIL_FROM_EMAIL");
  const fromName = Deno.env.get("MAIL_FROM_NAME") || "FID INFO COM";
  if (!login || !key || !fromEmail) return { ok: false, error: "SMTP_LOGIN / SMTP_KEY / MAIL_FROM_EMAIL non configurés" };
  try {
    const client = new SMTPClient({
      connection: { hostname: "smtp-relay.brevo.com", port: 587, tls: true, auth: { username: login, password: key } },
    });
    await client.send({ from: `${fromName} <${fromEmail}>`, to: [to], subject, content: text, html });
    await client.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email, client_id, client_name } = await req.json();
    if (!email || client_id === undefined || client_id === null) {
      return json({ error: "email et client_id sont requis" }, 400);
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const portalUrl = Deno.env.get("PORTAL_URL_CLIENT") || Deno.env.get("PORTAL_URL") || "";
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // 1) Sécurité : l'appelant doit être un membre du cabinet (table portal_admins) — INCHANGÉ
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: callerData } = await admin.auth.getUser(jwt);
    const caller = callerData?.user;
    if (!caller) return json({ error: "Non authentifié" }, 401);
    const { data: isAdmin } = await admin
      .from("portal_admins").select("user_id").eq("user_id", caller.id).maybeSingle();
    if (!isAdmin) return json({ error: "Action réservée au cabinet" }, 403);

    // 2) Créer le compte avec un mot de passe PROVISOIRE (au lieu de l'invitation Supabase native)
    let userId: string | null = null;
    let resent = false;
    const pass = genPassword(12);

    const created = await admin.auth.admin.createUser({
      email, password: pass, email_confirm: true,
      user_metadata: { client_id, client_name: client_name || "", role: "client" },
    });

    if (created.error) {
      if (/already.*registered|already.*exist/i.test(created.error.message || "")) {
        // Déjà inscrit -> on lui attribue un NOUVEAU mot de passe provisoire (l'ancien devient invalide)
        resent = true;
        const list = await admin.auth.admin.listUsers();
        const u = list.data?.users?.find((x) => (x.email || "").toLowerCase() === String(email).toLowerCase());
        if (!u) return json({ error: created.error.message }, 400);
        userId = u.id;
        const upd = await admin.auth.admin.updateUserById(userId, { password: pass });
        if (upd.error) return json({ error: upd.error.message }, 500);
      } else {
        return json({ error: created.error.message }, 400);
      }
    } else {
      userId = created.data.user?.id ?? null;
    }

    if (!userId) return json({ error: "Impossible de créer le compte" }, 500);

    // 3) Relier le compte au dossier du cabinet (un compte peut avoir plusieurs dossiers) — INCHANGÉ
    const up = await admin.from("portal_clients").upsert(
      { user_id: userId, client_id, client_name: client_name || "" },
      { onConflict: "user_id,client_id" },
    );
    if (up.error) return json({ error: up.error.message }, 500);

    // 4) Envoyer l'e-mail avec identifiant + mot de passe provisoire, via Brevo
    const subject = "Vos identifiants d'accès" + (client_name ? " — " + client_name : "");
    const text = `Bonjour,

Voici vos identifiants pour accéder à votre espace en ligne${client_name ? " (" + client_name + ")" : ""} :

Lien de connexion : ${portalUrl || "(à configurer)"}
Identifiant : ${email}
Mot de passe provisoire : ${pass}

Nous vous recommandons de changer ce mot de passe depuis votre profil dès votre première connexion.

Cordialement,
Le cabinet`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#14201C;line-height:1.6">
<p>Bonjour,</p>
<p>Voici vos identifiants pour accéder à votre espace en ligne${client_name ? " (<b>" + esc(client_name) + "</b>)" : ""} :</p>
<table style="margin:16px 0" cellpadding="6">
<tr><td style="color:#6b6858">Identifiant</td><td><b>${esc(email)}</b></td></tr>
<tr><td style="color:#6b6858">Mot de passe provisoire</td><td><b style="font-family:monospace">${esc(pass)}</b></td></tr>
</table>
${portalUrl ? `<p><a href="${esc(portalUrl)}" style="background:#14201C;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Accéder à mon espace</a></p>` : ""}
<p style="color:#6b6858;font-size:12.5px">Nous vous recommandons de changer ce mot de passe depuis votre profil dès votre première connexion.</p>
<p>Cordialement,<br>Le cabinet</p>
</div>`;

    const mail = await sendMail(email, subject, html, text);
    if (!mail.ok) return json({ ok: true, user_id: userId, resent, error: "Compte créé mais e-mail non envoyé : " + mail.error }, 502);

    return json({ ok: true, user_id: userId, resent });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
