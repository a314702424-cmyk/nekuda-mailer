# הגדרת Postfix ו-OpenDKIM לשליחה

המערכת מוסרת כל הודעה ל-Postfix בכתובת 127.0.0.1 בפורט 25, והוא אחראי לשליחה, לניסיונות חוזרים ולחתימה.

## Postfix (`/etc/postfix/main.cf`)

```
myhostname = MAIL_HOSTNAME            # תת-הדומיין החדש של שרת הדואר, זהה לרשומת ה-PTR
inet_interfaces = all
mynetworks = 127.0.0.0/8
recipient_delimiter = +               # נדרש כדי ש-bounce+מזהה@ יגיע לתיבת bounce
smtp_tls_security_level = may
smtpd_milters = inet:127.0.0.1:8891
non_smtpd_milters = inet:127.0.0.1:8891
milter_default_action = accept
```

## קליטת קפיצות (`/etc/aliases`)

```
bounce: "|/usr/bin/node --disable-warning=ExperimentalWarning /opt/nekuda-mailer/bin/bounce-pipe.js"
```

ואז `newaliases`. הסקריפט רץ כמשתמש של Postfix (בדרך כלל nobody), ולכן צריך לתת לו הרשאת כתיבה לתיקיית `data`,
או להגדיר ב-main.cf את `default_privs = nekuda`. הדומיין של כתובת הקפיצות צריך להיות ב-`mydestination`,
ורשומת MX שלו צריכה להפנות לשרת הזה. אם כתובת bounce@ הקיימת מטופלת במערכת הישנה, עדיף לבחור כתובת חדשה
בתת-דומיין חדש כדי לא להתנגש.

## OpenDKIM

1. `opendkim-genkey -b 2048 -d DOMAIN -s SELECTOR` (סלקטור חדש, לא הקיים).
2. להוסיף את הרשומה שנוצרה ב-`SELECTOR.txt` כרשומת TXT ב-DNS.
3. ב-`/etc/opendkim.conf`:

```
Domain    DOMAIN
Selector  SELECTOR
KeyFile   /etc/opendkim/keys/SELECTOR.private
Socket    inet:8891@localhost
Canonicalization relaxed/relaxed
SignHeaders From,To,Subject,Date,Message-ID,Reply-To,List-Unsubscribe,List-Unsubscribe-Post
```

חתימה על כותרות ההסרה נדרשת כדי ש-Gmail יכבד את ההסרה בלחיצה אחת.

## חימום כתובת IP חדשה

כתובת IP חדשה בלי היסטוריה תיחסם אם תשלח מיד מאות אלפי מיילים. במסך ההגדרות יש "תקרה יומית".
מומלץ להתחיל ב-500 ביום לנמענים שפתחו לאחרונה, ולהכפיל כל יומיים-שלושה כל עוד אין חסימות.
