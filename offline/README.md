# Offline copy

A copy of the whole system that runs on this laptop without internet: the
customer site, booking, My Appointment, and the admin console, using a copy of
the live data. Nothing done here reaches the live site.

- **Off:** the booking security check (captcha) and real emails.
- **Text messages** go out through an Android phone on the same hotspot, with no
  internet (see [Text messages](#text-messages)). Only bookings made in the
  offline copy are texted; customers copied from the live site never are.
- **Emails** (verification codes, confirmations) go to a test inbox on the
  laptop instead: <http://127.0.0.1:54324>.
- **The footer map** shows the address instead of Google Maps. Messenger and
  Facebook links still need internet.

## Start

1. Open **Docker Desktop** and wait until it says it is running.
2. In a terminal in the project folder, start the local database (about 1
   minute):

   ```
   npm run offline:db
   ```

3. Start the app, and leave this terminal open:

   ```
   npm run offline
   ```

4. Open <http://localhost:4000>. Pages take a few seconds the first time each
   one opens.

**Admin:** <http://localhost:4000/auth>, with the same email and password as the
live site at the time of the copy.

**Database viewer** (to look at tables): <http://127.0.0.1:54323>.

## Phones

1. Turn on a phone's hotspot. Its mobile data can be off.
2. Connect the laptop and the other phones to that hotspot.
3. Restart `npm run offline`. Use the `Network:` address it prints, for
   example `http://192.168.43.120:4000`, on the phones.

If Windows asks whether to allow Node.js, choose **Allow**.

On phones, the Copy code button shows "Could not copy the code automatically".
That is expected over this address; the code can still be copied by hand.

## Text messages

Texts are sent by an Android phone with a SIM and load, running the free app
**SMS Gateway for Android**. The laptop hands each text to the phone over the
hotspot, and the phone sends it as a normal SMS. Each text uses the SIM's load,
and customers see that phone's number.

One time:

1. Install **SMS Gateway for Android** on the phone from <https://sms-gate.app>
   and allow it to send SMS.
2. In Android settings, turn off battery optimisation for the app, so it keeps
   running with the screen off.

Each time:

1. Turn on this phone's hotspot (mobile data can be off) and connect the laptop
   to it.
2. In the app, turn on **Local Server**, then tap the status button at the
   bottom until it says **Online**. The Local Server section shows the phone's
   address, a username and a password.
3. Check that the laptop can reach the phone: open
   `http://<phone address>:8080/docs` on the laptop. A page should load.
4. In `.env.offline`, fill in:

   ```
   SMS_GATEWAY_URL=http://<phone address>:8080
   SMS_GATEWAY_USERNAME=<username from the app>
   SMS_GATEWAY_PASSWORD=<password from the app>
   ```

5. Restart the app: press `Ctrl+C`, then run `npm run offline` again. Changes to
   `.env.offline` only take effect after a restart.
6. Test it: book with your own mobile number, then confirm the booking in the
   admin. The confirmation text should arrive within a minute.

The phone's address can change when the hotspot restarts. If texts stop, check
step 2 again and update `SMS_GATEWAY_URL`.

## Reminders and automatic retries

Every 5 minutes the local database asks the app to send appointment reminders
that are due and to retry customer texts and emails that failed. This only
happens while `npm run offline` is running.

- Reminder emails appear in the test inbox; reminder texts go through the phone
  (new bookings only, as above).
- Reminder timing is set in the admin under **Settings → Shop information**.
- A message that still fails after 5 tries shows up in the admin's
  notifications, asking you to contact the customer.
- If the app is stopped for more than 30 minutes while the database keeps
  running, the admin shows "Automatic reminders and retries have stopped". That
  is expected after a break; mark it read.

## When the internet comes back

The offline copy can send the bookings made here to the live site once the
internet is back, then move everyone to the live site. It is **off** until you
switch it on, because while it is on, every booking made here (test bookings
too) goes to the real live site within a minute whenever this laptop has
internet.

To switch it on, set these in `.env.offline`, then restart `npm run offline`:

```
OFFLINE_SYNC_TO_LIVE=1
LIVE_SITE_URL=https://<the live website>
```

What happens then:

1. Every minute the laptop checks whether the live site can be reached. Every
   page shows a small status in the bottom-right corner.
2. When it can, each booking made here is added to the live site with the same
   reference code, oldest first. Bookings confirmed here stay confirmed; the
   live site emails the confirmation but does not repeat a text the phone
   already sent.
3. A booking that no longer fits on the live site (its time was taken online
   in the meantime, for example) is not added. The live admin and this admin
   get a notification with the customer's number to call.
4. Once nothing is left to send, people using this laptop's address move to the
   live site on their next page change, never in the middle of a form. Admins
   then sign in on the live site.

Not sent: cancellations, edits and reschedules made here, finished services,
products added to a booking here, and bookings whose time has already passed.
Make those on the live site by hand.

## Stop

1. Press `Ctrl+C` in the app terminal.
2. Stop the database:

   ```
   npm run offline:db:stop
   ```

Bookings and changes are kept for next time.

## Good to know

- Bookings made here stay here unless sending to the live site is switched on
  (see [When the internet comes back](#when-the-internet-comes-back)). Live
  bookings made after the copy never appear here.
- The copied live data lives in `offline/data/` and `offline/storage/`, and the
  local keys in `.env.offline`. Git ignores all three; never commit them, since
  the repository is public.
- `offline/setup.sql` adds what a data copy leaves out: the image folders and
  the scheduled jobs (service progress notifications and clean-ups).
