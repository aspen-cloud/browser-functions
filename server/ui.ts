/**
 * Copyright 2019 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import NextServer from "next/dist/next-server/server/next-server";

import path from "path";
import bodyParser from "body-parser";
import * as Formidable from "formidable";
import security from "./security";
import Express from "express";
import utils from "./utils";
import config from "./config";
import functions from "./functions";

const regex = utils.regex;

const serveOptions = { root: __dirname + "/../ui/" };

export default function setupUi(app: Express.Router, nextjs: NextServer) {
  serveStaticPages(app, nextjs);
  serveLandingPage(app);
  functionsRoutes(app, nextjs);
  packageRoutes(app);
  logRoutes(app);
  createNewUserFunctionsRoute(app);
  createLoginRoute(app);
  createNewAppRoute(app);
  createApplicationSaveRoute(app);
}

function serveLandingPage(app) {
  app.get("/", (req, res) => {
    const urlApplicationId = utils.getApplicationIdAsSubDomain(req);
    const authToken = security.getAuthenticationToken(req);

    if (!authToken && !urlApplicationId) {
      res.sendFile("index.html", serveOptions);
      return;
    }

    if (!authToken || !urlApplicationId) {
      res.redirect("/login");
      return;
    }

    if (authToken && urlApplicationId) {
      const applicationId = functions.getApplicationIdFromAuthToken(authToken);

      if (
        applicationId &&
        applicationId.toLowerCase() === urlApplicationId.toLowerCase()
      ) {
        res.sendFile("functions.html", serveOptions);
      } else {
        res.redirect("/login");
      }
    }
  });

  app.get("/unsupported-browser", (req, res) => {
    res.sendFile("unsupported-browser.html", serveOptions);
  });
}

function serveStaticPages(app, nextjs) {
  app.use("/docs", Express.static("docs/"));
  app.use("/assets", Express.static("ui/assets"));
  app.use("/components", Express.static("ui/components"));
  app.use("/utils", Express.static("ui/utils"));
  app.get("/login", (req, res) => res.sendFile("login.html", serveOptions));
  app.get("/create", (req, res) => nextjs.render(req, res, "/editor", {})); // TODO add templates for JSX, Python, etc
  app.get("/new", (req, res) => res.sendFile("new.html", serveOptions));
  app.get("/docs", (req, res) => res.sendFile("docs.html", serveOptions));
  app.get("/packages", (req, res) =>
    nextjs.render(req, res, "/packages", req.query),
  ); //serverOptions?
}

function createApplicationSaveRoute(app: Express.Router) {
  app.post(
    "/application/edit",
    security.verifyAuthToken,
    bodyParser.json(),
    function (req, res) {
      functions.updateApplication(req.applicationId, req.body).then(() => {
        res.sendStatus(200);
      });
    },
  );
}

function createLoginRoute(app: Express.Router) {
  app.post(
    "/login",
    bodyParser.urlencoded({ extended: false }),
    function (req, res) {
      const authToken = req.body.accessKey;
      const appId = functions.getApplicationIdFromAuthToken(authToken);
      if (!appId) {
        utils.renderTemplate(res, serveOptions.root + "login.html", {
          error: "Access token could not be validated",
        });
      } else {
        const reqPort = utils.getPortFromRequest(req);
        res.redirect(
          `${req.protocol}://${appId}.${config.functionDomain}${reqPort}?access-key=${authToken}`,
        );
      }
    },
  );
}

function createNewAppRoute(app: Express.Router) {
  app.post(
    "/new",
    bodyParser.urlencoded({ extended: false }),
    async function (req, res) {
      let applicationId = req.body.applicationId;
      let email = req.body.email;

      if (!applicationId || !email) {
        utils.renderTemplate(res, serveOptions.root + "new.html", {
          error: "Email and Application ID are required",
        });
        return;
      }

      applicationId = applicationId.toLowerCase();
      email = email.toLowerCase();

      let error;

      if (applicationId.length < 5) {
        error = "Application ID must be at least 5 characters";
      }

      if (!regex.filename.test(applicationId)) {
        error = "Application ID contains invalid characters";
      }

      if (functions.checkFunctionExists(applicationId)) {
        error = "Application ID is not available";
      }

      if (!regex.email.test(email)) {
        error = "Email address is not valid";
      }

      if (error) {
        utils.renderTemplate(res, serveOptions.root + "new.html", {
          error,
          fields: { applicationId, email },
        });
        return;
      }

      try {
        const accessKey = await functions.createNewApplication(
          applicationId,
          email,
        );
        utils.renderTemplate(res, serveOptions.root + "new.html", {
          accessKey,
          applicationId,
        });
      } catch (e) {
        utils.renderTemplate(res, serveOptions.root + "new.html", {
          error: e.message,
        });
      }
    },
  );
}

function logRoutes(app: Express.Router) {
  app.get("/logs", security.verifyAuthToken, (req, res) =>
    res.sendFile("logs.html", serveOptions),
  );

  app.get("/log-data", security.verifyAuthToken, async function (req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const tail = await functions.tailLogs(req.applicationId, (line) => {
      res.write(`data: ${line}\n\n`);
    });

    res.on("close", function (e) {
      tail.unwatch();
    });
  });
}

function functionsRoutes(app: Express.Router, nextjs) {
  app.get("/functions", security.verifyAuthToken, async function (req, res) {
    const appData = functions.getApplicationMetaData(req.applicationId);
    const data = {};
    data[req.applicationId] = {
      functions: appData.files,
      settings: appData.settings,
    };
    res.send(data);
  });

  app.delete(
    "/functions/:appId/:functionName",
    security.verifyAuthToken,
    async function (req, res) {
      await functions.deleteFunction(req.params.appId, req.params.functionName);
      res.sendStatus(200);
    },
  );

  app.get("/code/*", security.verifyAuthToken, async function (req, res) {
    const functionName = req.params[0];
    const code = await functions.getFunctionAsString(
      req.applicationId,
      functionName,
    );

    res.send(code);
  });

  app.get("/edit", security.verifyAuthToken, async function (req, res) {
    const appData = functions.getApplicationMetaData(req.applicationId);
    const functionName = req.query.open;
    let code;
    if (functionName) {
      code = await functions.getFunctionAsString(
        req.applicationId,
        functionName,
      ); // TODO: may fail
    }
    return nextjs.render(req, res, `/editor`, {
      fileTree: appData.files,
      code,
      fileKey: functionName,
      applicationId: req.applicationId
    });
  });
}

function packageRoutes(app: Express.Router) {
  app.get("/dependencies", security.verifyAuthToken, async function (req, res) {
    const appData = functions.getApplicationDependencies(req.applicationId);
    res.send(appData);
  });

  app.post(
    "/dependencies/add",
    security.verifyAuthToken,
    bodyParser.json(),
    async function (req, res) {
      const dependencies = req.body["pack-names"];
      const isDev = req.body["dev-check"] || false;

      if (!dependencies) {
        res.status(500);
        res.send("Could not parse dependencies");
        return;
      }

      try {
        await functions.addDependencies(req.applicationId, dependencies, isDev);
      } catch {
        res.status(500);
        res.send("Failed to add dependencies");
        return;
      }

      const appData = functions.getApplicationDependencies(req.applicationId);
      res.send(appData);
    },
  );
}

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };

  return text.replace(/[&<>"']/g, function (m) {
    return map[m];
  });
}

function createNewUserFunctionsRoute(app: Express.Router) {
  app.put(
    "/static/*",
    security.verifyAuthToken,
    bodyParser.text({
      type: "text/plain",
      limit: "500mb",
    }),
    async function (req, res) {
      const params = path.parse(req.params[0]);
      const fileName = params.name;
      const fileType = params.ext.replace(".", "");
      const folder = params.dir ? params.dir + "/" : params.dir;

      const functionSettings = functions.getApplicationMetaData(
        req.applicationId,
      ).settings;
      if (functionSettings.readonly) {
        res.status(400);
        res.send("Function is readonly");
        return;
      }

      let functionName = fileName;
      if (fileType) {
        functionName = `${functionName}.${fileType}`;
      }
      if (!regex.filename.test(fileName) || !regex.filename.test(fileType)) {
        res.status(400);
        res.send("Function name contains invalid characters");
        return;
      }
      await functions.addFunctionString(
        req.applicationId,
        folder + functionName,
        req.body,
      );
      res.sendStatus(200);
    },
  );

  app.post(
    "/function/create",
    security.verifyAuthToken,
    async function (req, res) {
      const form = new Formidable.IncomingForm();
      const files = [];
      const fields: Formidable.Fields = {};

      form
        .on("field", function (field: string, value) {
          fields[field] = value;
        })
        .on("file", function (field: string, file) {
          files.push(file);
        })
        .on("end", async function () {
          if (files.length > 0) {
            // uploading function file
            const file = files[0]; //files are uploaded one at a time so we should only ever have 1
            fields.fullPath;
            await functions.addFunctionFile(
              req.applicationId,
              file,
              fields.fullPath,
            );
            res.sendStatus(200);
          }
        });

      form.parse(req);
    },
  );
}
