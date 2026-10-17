# BatchZip ko website pe chalao (shareable link) — 5 minute

Ye guide Render ke **free plan** pe deploy karega. Permanent link milega
jaise `https://batchzip-downloader.onrender.com` — doston ko share kar sakte ho.

> Note: free plan me 15 minute idle rehne pe server so jata hai, pehli
> baar khulne me ~30 second lagega. Normal hai. ZIP turant download kar
> lena — server so jaye to purani files delete ho sakti hain.

## Naya feature: 🎙️ Audio Merge

Audio links paste karne se pehle **"🔗 Audios ko merge karke ek file banao"** wala
checkbox tick karo (neeche MP3/WAV format chun sakte ho). Saare audios sequence
me download honge, phir 1, 2, 3… order me jod ke **ek hi audio file** ban jayegi —
batch complete hote hi **"🎙️ Download merged audio"** button milega.

> Technical note: Docker image me ffmpeg pehle se included hai (`Dockerfile`
> me `apk add ffmpeg`), isliye Render pe deploy karte hi audio merge kaam
> karega — kuch extra karne ki zaroorat nahi.

## Step 1 — Code GitHub pe dalo (2 minute)

1. [github.com](https://github.com) pe login karo → **New repository** → naam rakho `batchzip` → **Create repository**
2. **"uploading an existing file"** wale link pe click karo
3. Apne computer pe `~/workspace/batchzip` folder kholo, **saari files aur folders** select karke GitHub pe drag-drop karo → **Commit changes**

## Step 2 — Render pe deploy karo (3 minute)

1. [render.com](https://render.com) pe **free account** banao (GitHub se login sabse easy)
2. Dashboard me **New → Blueprint** dabao
3. **Connect a repository** → apna `batchzip` repo select karo → **Connect**
4. Render khud `render.yaml` file padh lega — saari settings automatic bhari milengi
5. **Apply** dabao → deploy shuru (2-3 minute lagega)

## Step 3 — Link lo

Deploy complete hote hi Render tumhe link dega, jaise:

```
https://batchzip-downloader.onrender.com
```

Browser me kholo — BatchZip website chal rahi hogi. Yehi link share karna hai.

## Problem aaye to

- **Build fail ho jaye** → Render dashboard me "Logs" kholo, last wali red line dekho
- **Pehli baar khulne me time lage** → normal hai, 30 second wait karo
- **File gayab ho jaye** → free plan ka server so gaya tha; dobara batch chalao, ZIP turant download kar lo
