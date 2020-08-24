/* eslint no-console: "off" */

import retry from "async-retry";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import { MongoClient } from "mongodb";
import nunjucks from "nunjucks";
import path from "path";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import passport from "passport";
import { Strategy } from "passport-local";
import expressSession from "express-session";
import { User } from "../models/user";

const loginMiddleware = (req: any, res: any, next: Function) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.redirect("/");
  }
  next();
};

const loginStrategy = (username: string, password: string, cb: Function) => {
  dbPromise.then((db: any) => {
    db.collection("users").findOne({ username }, (err: Error, user: User) => {
      if (err) return cb(err);
      if (!user) return cb(null, false);
      const hash = user.passwordHash;
      bcrypt.compare(password, hash, (err: Error, isValid: Boolean) => {
        if (!isValid) return cb(null, false);
        return cb(null, user);
      });
    });
  });
};
passport.use(new Strategy(loginStrategy));

passport.serializeUser((user: User, cb: Function) => {
  cb(null, user.username);
});

passport.deserializeUser((username: string, cb: Function) => {
  dbPromise.then((db: any) => {
    db.collection("users").findOne({ username }, (err: Error, user: User) => {
      if (err) return cb(err);
      if (!user) return cb(null, false);
      cb(null, user);
    });
  });
});

dotenv.config();
const host = process.env.PORT ? undefined : "127.0.0.1";
const port = +(process.env.PORT || 5000);
const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017";
const mongoDbName = process.env.MONGO_DB_NAME || "musicparsed";

const dbPromise = (async () => {
  const mongoClient = await retry(
    () =>
      MongoClient.connect(mongoUri, {
        reconnectTries: Infinity,
        useNewUrlParser: true,
      }),
    { forever: true, maxTimeout: 30000 }
  );
  return mongoClient.db(mongoDbName);
})();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const sessionKey = process.env.SESSION_KEY;
app.use(
  expressSession({
    secret: sessionKey,
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Compatibility with Jinja2 templates
const env = nunjucks.configure(path.resolve(__dirname, "../templates"), {
  express: app,
  watch: true,
});
app.set("view engine", "html");

const manifestPath = path.resolve(__dirname, "../static/dist/manifest.json");

// Provide the webpack manifest
let reloadManifest = true;
app.use((req, res, next) => {
  if (reloadManifest) {
    env.addGlobal("manifest", null);
    reloadManifest = false;
    fs.watch(manifestPath, { persistent: false }, () => {
      reloadManifest = true;
    });
  }
  if (
    ((env as unknown) as { getGlobal(name: string): unknown }).getGlobal(
      "manifest"
    ) === null
  ) {
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, { encoding: "utf-8" })
    );
    env.addGlobal("manifest", manifest);
  }
  next();
});

// Routes
app.get("/api/song", async (req, res) => {
  const db = await dbPromise;
  res.json(
    await db
      .collection("songs")
      .find(
        {},
        { projection: { artist: 1, songId: 1, tags: 1, title: 1, url: 1 } }
      )
      .toArray()
  );
});

app.post("/api/song", loginMiddleware, async (req, res) => {
  const db = await dbPromise;
  const query = {
    title: req.body.title,
    artist: req.body.artist,
    id: req.body.id,
  };
  await db
    .collection("songs")
    .updateOne(query, { $set: req.body }, { upsert: true });
  res.send(`Added song ${req.body.title}`);
});

app.delete("/api/song/:id", loginMiddleware, async (req, res) => {
  const db = await dbPromise;
  const query = {
    id: req.params.id,
  };
  await db.collection("songs").deleteOne(query);
  res.send("Deleted!");
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
});

app.post(
  "/api/login",
  passport.authenticate("local", { failureRedirect: "/login" }),
  loginLimiter,
  (req, res, next) => {
    res.redirect("/edit");
  }
);

app.use("/static", express.static(path.resolve(__dirname, "../static")));

app.get(["/", "/all"], (req, res) => res.render("all_songs"));

app.get("/convert", (req, res) => res.render("convert"));

app.get("/import", (req, res) => res.render("import"));

app.get("/render", (req, res) => res.render("render_chords"));

app.get("/aus", (req, res) => res.render("aus"));

app.get("/guides", (req, res) => res.render("guides/index"));

app.get("/guides/:guide_type", (req, res) =>
  res.render(`guides/${req.params.guide_type}`)
);

app.get("/song/:artist/:title", (req, res) =>
  res.render("index", {
    title: req.params.title,
    artist: req.params.artist,
    transpose: req.query.transpose | 0,
  })
);

app.get("/edit", loginMiddleware, (req, res) => {
  res.render("edit_songs");
});

app.get("/login", (req, res) => res.render("login"));

const callback = (): void => {
  console.log(`Listening on port ${port}`);
};

// Start server
if (host === undefined) {
  app.listen(port, callback);
} else {
  app.listen(port, host, callback);
}
