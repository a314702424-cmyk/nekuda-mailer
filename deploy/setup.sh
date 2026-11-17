#!/usr/bin/env bash
# התקנה על Ubuntu 24.04 נקי. להריץ כ-root מתוך תיקיית הפרויקט:
#   SITE_HOST=diur.example.org MAIL_HOST=mta.example.org SIGN_DOMAIN=example.org bash deploy/setup.sh
# הסקריפט לא נבדק עדיין על שרת אמיתי. הוא בטוח להרצה חוזרת.
set -euo pipefail

SITE_HOST="${SITE_HOST:?חסר SITE_HOST (תת-הדומיין של האתר)}"
MAIL_HOST="${MAIL_HOST:?חסר MAIL_HOST (תת-הדומיין של שרת הדואר)}"
SIGN_DOMAIN="${SIGN_DOMAIN:?חסר SIGN_DOMAIN (הדומיין שמופיע בכתובת השולח)}"
DKIM_SELECTOR="${DKIM_SELECTOR:-nm1}"
APP_DIR=/opt/nekuda-mailer
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "== חבילות =="
apt-get update -y
echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "postfix postfix/mailname string ${MAIL_HOST}" | debconf-set-selections
apt-get install -y curl ca-certificates gnupg nginx postfix opendkim opendkim-tools sqlite3 ufw openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== האפליקציה =="
id nekuda >/dev/null 2>&1 || useradd -r -d "$APP_DIR" -s /usr/sbin/nologin nekuda
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  cp -a "$SRC_DIR"/. "$APP_DIR"/
fi
mkdir -p "$APP_DIR/data"
chown -R nekuda:nekuda "$APP_DIR"
cp "$APP_DIR/deploy/nekuda-mailer.service" /etc/systemd/system/nekuda-mailer.service
systemctl daemon-reload
systemctl enable nekuda-mailer
systemctl restart nekuda-mailer

echo "== nginx =="
if [ ! -f /etc/ssl/private/nekuda-selfsigned.key ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=${SITE_HOST}" \
    -keyout /etc/ssl/private/nekuda-selfsigned.key -out /etc/ssl/certs/nekuda-selfsigned.crt
fi
cat > /etc/nginx/sites-available/nekuda-mailer <<NGINX
server {
    listen 80;
    listen 443 ssl;
    server_name ${SITE_HOST};
    ssl_certificate /etc/ssl/certs/nekuda-selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/nekuda-selfsigned.key;
    client_max_body_size 90m;
    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/nekuda-mailer /etc/nginx/sites-enabled/nekuda-mailer
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "== OpenDKIM =="
mkdir -p /etc/opendkim/keys
if [ ! -f "/etc/opendkim/keys/${DKIM_SELECTOR}.private" ]; then
  opendkim-genkey -b 2048 -d "$SIGN_DOMAIN" -s "$DKIM_SELECTOR" -D /etc/opendkim/keys
fi
chown -R opendkim:opendkim /etc/opendkim
chmod 600 "/etc/opendkim/keys/${DKIM_SELECTOR}.private"
cat > /etc/opendkim.conf <<DKIM
Syslog                  yes
UMask                   007
Mode                    s
Domain                  ${SIGN_DOMAIN}
Selector                ${DKIM_SELECTOR}
KeyFile                 /etc/opendkim/keys/${DKIM_SELECTOR}.private
Socket                  inet:8891@localhost
Canonicalization        relaxed/relaxed
InternalHosts           127.0.0.1
SignHeaders             From,To,Subject,Date,Message-ID,Reply-To,List-Unsubscribe,List-Unsubscribe-Post
UserID                  opendkim
PidFile                 /run/opendkim/opendkim.pid
DKIM
systemctl enable opendkim
systemctl restart opendkim

echo "== Postfix =="
postconf -e "myhostname = ${MAIL_HOST}" "myorigin = ${MAIL_HOST}" \
  "mydestination = ${MAIL_HOST}, localhost" "inet_interfaces = all" "mynetworks = 127.0.0.0/8 [::1]/128" \
  "recipient_delimiter = +" "smtp_tls_security_level = may" "smtpd_tls_security_level = may" \
  "smtpd_milters = inet:127.0.0.1:8891" "non_smtpd_milters = inet:127.0.0.1:8891" "milter_default_action = accept" \
  "default_privs = nekuda" "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination" \
  "message_size_limit = 20480000"
if ! grep -q '^bounce:' /etc/aliases; then
  echo "bounce: \"|/usr/bin/node --disable-warning=ExperimentalWarning ${APP_DIR}/bin/bounce-pipe.js\"" >> /etc/aliases
fi
newaliases
systemctl restart postfix

echo "== חומת אש =="
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 25/tcp >/dev/null
ufw --force enable >/dev/null

IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
DKIM_VALUE="$(sed -e 's/^[^(]*(//' -e 's/).*$//' "/etc/opendkim/keys/${DKIM_SELECTOR}.txt" | tr -d '"\n\t ' )"
cat > /root/nekuda-dns.txt <<DNS
רשומות DNS להוספה (כולן חדשות, אין צורך לשנות רשומה קיימת):

1. A     ${SITE_HOST}     ${IP}     (אפשר עם הפרוקסי של Cloudflare)
2. A     ${MAIL_HOST}     ${IP}     (DNS only, בלי פרוקסי)
3. TXT   ${MAIL_HOST}     v=spf1 a -all
4. TXT   ${DKIM_SELECTOR}._domainkey.${SIGN_DOMAIN}     ${DKIM_VALUE}

אצל ספק השרת: להגדיר PTR (reverse DNS) של ${IP} אל ${MAIL_HOST}. ב-DigitalOcean זה נקבע לפי שם הדרופלט.

במסך ההגדרות של האתר:
  כתובת האתר:        https://${SITE_HOST}
  כתובת לקפיצות:     bounce@${MAIL_HOST}
  שם המארח ב-EHLO:   ${MAIL_HOST}
  תקרה יומית:        500 (להעלות בהדרגה)
DNS
cat /root/nekuda-dns.txt
echo "== הסתיים. האתר רץ על http://${IP} (דרך nginx) =="
