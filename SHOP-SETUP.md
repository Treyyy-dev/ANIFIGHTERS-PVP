# Turn on the AniFighters gem shop (Stripe)

The gem shop is already built into the game and the server. Players open it with the **+** next to their gems. It stays closed ("THE SHOP IS NOT OPEN YET") until your server has a Stripe key.

| Pack | Price |
|---|---|
| 200 gems | $0.99 |
| 1,100 gems | $4.99 |
| 2,400 gems | $9.99 |
| 5,200 gems (POPULAR) | $19.99 |
| 14,000 gems (BEST VALUE) | $49.99 |

## 1. Create a Stripe account

1. Sign up at stripe.com. It's free. The account owner has to be an adult (18+).
2. You can test right away. To take real money you'll add your business details and a bank account later (step 3).

## 2. Test it first (no real money)

1. In the Stripe Dashboard, switch on **Test mode** (toggle at the top right).
2. Go to **Developers → API keys** and copy the **Secret key**. It starts with `sk_test_`.
3. On render.com, open your `anifighters-pvp` service → **Environment** → **Add environment variable**:
   - Key: `STRIPE_SECRET_KEY`
   - Value: the `sk_test_...` key
   
   Save. Render restarts the server by itself.
4. Open `https://anifighters-pvp.onrender.com/health`. It should now say `"shop":true`.
5. In the game, tap **+** next to your gems and buy any pack. On the Stripe page, pay with the test card **4242 4242 4242 4242**, any future expiry date, any CVC and any ZIP.
6. Go back to the game. The gems arrive by themselves (or tap **CHECK NOW** in the shop).
7. In Stripe (still in Test mode) → **Payments** you'll see the purchase. After the gems were delivered, the payment has `claim` in its metadata.

## 3. Go live (real money)

1. In the Stripe Dashboard, click **Activate account** and fill in your business info and bank account for payouts. Stripe may ask for a website with your contact info and a refund policy. You can add a simple page for that to your GitHub Pages site.
2. Switch **Test mode** off, go to **Developers → API keys**, and copy the live **Secret key** (`sk_live_...`).
3. On Render, replace the value of `STRIPE_SECRET_KEY` with the live key and save.

## Settings (Render → Environment)

| Name | Needed? | What it does |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Turns the shop on. `sk_test_...` for testing, `sk_live_...` for real sales. |
| `SHOP_CURRENCY` | No | Currency code, default `usd`. Prices are in its smallest unit (cents). |
| `SHOP_RETURN_URL` | No | Where the "BACK TO THE GAME" button goes after paying. Default `https://treyyy-dev.github.io/AniFighters/`. |

To change prices or gem amounts, edit `PACKS` in the gem shop section of `server.js` (`cents` is the price in cents). The game shows whatever the server sends.

## How it stays safe

- **The secret key lives only on Render.** Never put it in the game files or a GitHub repository. If it ever leaks, roll it in Stripe (Developers → API keys) and paste the new one on Render.
- **Prices are set on the server**, so players can't change them.
- **Players pay on Stripe's own page** (card, Apple Pay, Google Pay). Card details never touch the game or your server.
- **Each purchase gives its gems once.** When the server hands out the gems it writes `claim` on that Stripe payment. Another phone or a copy of the game can't collect the same purchase again, even after a server restart.
- **Nothing is lost if the game is closed mid-purchase.** The purchase waits on the player's device and pays out the next time they open the game, as long as they paid within 24 hours (Stripe checkout pages expire after 24 hours).

## Good to know

- **Saves:** gems are saved on the player's device, and also in their Google cloud save if they log in (the shop reminds them). If a player who never logged in loses their phone, their gems are gone. You can find their payment in Stripe and refund it if you want.
- **Refunds:** Stripe Dashboard → **Payments** → choose the payment → **Refund**. A refund doesn't take gems back in the game.
- **Fees:** Stripe charges per payment, about 2.9% + 30¢ for a US card. Check stripe.com/pricing for your country.
- **App stores:** this shop is for the web game. If you ever publish AniFighters in the Google Play Store or Apple App Store, their in-app purchase rules apply there.
- **Taxes:** depending on where you and your players live, sales tax or VAT may apply. Stripe Tax can handle it for an extra fee. I'm not a lawyer or tax advisor, so check what applies to you.
