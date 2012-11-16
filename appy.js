var express = require('express');
var _ = require('underscore');
var passport = require('passport');
var fs = require('fs');
var async = require('async');
var mongo = require('mongodb');
var connectMongoDb = require('connect-mongodb');
var flash = require('connect-flash');

var options;
var db;
var app;
var insecure = { login: true, logout: true };

var authStrategies = {
  twitter: function(authOptions)
  {
    var TwitterStrategy = require('passport-twitter').Strategy;
    passport.use(new TwitterStrategy(
      authOptions,
      function(token, tokenSecret, profile, done) {
        // We now have a unique id, username and full name
        // (display name) for the user courtesy of Twitter.

        var user = _.clone(profile);

        // For the convenience of mongodb
        user._id = user.id;

        // Also copy the token and tokenSecret so that
        // we can send tweets on the user's behalf at 
        // any time via ntwitter
        user.token = token;
        user.tokenSecret = tokenSecret;

        // If you want to capture information about the user
        // permanently in the database, this is a great callback
        // to do it with
        if (options.beforeSignin) {
          options.beforeSignin(user, function() {
            done(null, user);
          });
        } else {
          done(null, user);
        }
      }
    ));

    // Redirect the user to Twitter for authentication.  When complete, Twitter
    // will redirect the user back to the application at
    // /auth/twitter/callback
    app.get('/login', passport.authenticate('twitter'));

    // Twitter will redirect the user to this URL after approval.  Finish the
    // authentication process by attempting to obtain an access token.  If
    // access was granted, the user will be logged in.  Otherwise,
    // authentication has failed.
    app.get('/twitter-auth',
      passport.authenticate('twitter', { successRedirect: '/twitter-auth-after-login',
                                         failureRedirect: '/' }));
    app.get('/twitter-auth-after-login', function(req, res) {
      if (req.session.afterLogin) {
        return res.redirect(req.session.afterLogin);
      } else {
        return res.redirect('/');
      }
    });
  },
  local: function(options)
  {
    var LocalStrategy = require('passport-local').Strategy;
    passport.use(new LocalStrategy(
      function(username, password, done) {
        var user = _.find(options.users, function(user) {
          return ((user.username === username) && (user.password === password));
        });
        if (!user) {
          return done(null, false, { message: 'Invalid username or password' });
        }
        return done(null, user);
      }
    ));
    app.get('/login', function(req, res) {
      var message = req.flash('error');
      if (!options.template) {
        options.template =
          '<% if (message) { %>' +
          '<h3><%= message %></h3>' +
          '<% } %>' +
          '<form action="/login" method="post">' +
            '<div>' +
            '<label>Username:</label>' +
            '<input type="text" name="username" /><br/>' +
            '</div>' +
            '<div>' +
            '<label>Password:</label>' +
            '<input type="password" name="password"/>' +
            '</div>' +
            '<div>' +
            '<input type="submit" value="Submit"/>' +
            '</div>' +
          '</form>';
      }
      if (typeof(options.template) !== 'function') {
        options.template = _.template(options.template);
      }
      res.send(options.template({ message: message }));
    });
    app.post('/login',
      passport.authenticate('local',
        { failureRedirect: '/login', failureFlash: true }),
      function(req, res) {
        res.redirect('/');
      }
    );
  }
};

module.exports.bootstrap = function(optionsArg)
{
  options = optionsArg;

  async.series([dbBootstrap, appBootstrap], function(err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }
    options.ready(app, db);
  });
}

function dbBootstrap(callback) {
  if (!options.db.host) {
    options.db.host = 'localhost';
  }
  if (!options.db.port) {
    options.db.port = 27017;
  }
  // Open the database connection
  db = module.exports.db = new mongo.Db(
    options.db.name,
    new mongo.Server(options.db.host, options.db.port, {}),
    // Sensible default of safe: true
    // (soon to be the driver's default)
    { safe: true });

  db.open(function(err) {
    if (err)
    {
      callback(err);
      return;
    }
    if (options.db.collections) {
      async.map(options.db.collections, function(info, next) {
        var name;
        var options;
        if (typeof(info) !== 'string') {
          name = info.name;
          options = info;
          delete options.name;
        }
        else
        {
          name = info;
          options = {};
        }
        db.collection(name, options, function(err, collection) {
          if (err) {
            console.log('no ' + name + ' collection available, mongodb offline?');
            console.log(err);
            process.exit(1);
          }
          if (options.index) {
            options.indexes = [ options.index ];
          }
          if (options.indexes) {
            async.map(options.indexes, function(index, next) {
              var fields = index.fields;
              // The remaining properties are options
              delete index.fields;
              collection.ensureIndex(fields, index, next);
            }, function(err) {
              if (err) {
                console.log('Unable to create index');
                console.log(err);
                process.exit(1);
              }
              afterIndexes();
            });
          }
          else
          {
            afterIndexes();
          }
          function afterIndexes() {
            module.exports[name] = collection;
            next();
          }
        });
      }, callback);
    }
    else
    {
      callback(null);
    }
  });
}

function appBootstrap(callback) {
  app = module.exports.app = express();

  // Serialize users directly in the session. So far this
  // works for the passport strategies I've used and
  // avoids database hits

  passport.serializeUser(function(user, done) {
    done(null, JSON.stringify(user));
  });

  passport.deserializeUser(function(json, done) {
    var user = JSON.parse(json);
    if (user)
    {
      done(null, user);
    }
    else
    {
      done(new Error("Bad JSON string in session"), null);
    }
  });

  if (options.host) {
    app.use(canonicalizeHost);
  }

  if (options.static)
  {
    app.use(express.static(options.static));
  }

  app.use(express.bodyParser());
  app.use(express.cookieParser());

  // Express sessions let us remember the mood the user wanted while they are off logging in on twitter.com
  // The mongo session store allows our sessions to persist between restarts of the app
  var mongoStore = new connectMongoDb({ db: db });

  app.use(express.session({ secret: options.sessionSecret, store: mongoStore }));
  // We must install passport's middleware before we can set routes that depend on it
  app.use(passport.initialize());
  // Passport sessions remember that the user is logged in
  app.use(passport.session());

  // Always make the user object available to templates
  app.use(function(req, res, next) {
    res.locals.user = req.user ? req.user : null;
    next();
  });

  app.use(flash());
  app.set('view engine', 'jade');

  // Before we set up any routes we need to set up our security middleware

  if (!options.unlocked)
  {
    options.unlocked = [];
  }
  _.each(['/login', '/logout', '/twitter-auth'], function(url) {
    if (!_.include(options.unlocked, url))
    {
      options.unlocked.push(url);
    }
  });

  if (options.locked === true) {
    // Secure everything except prefixes on the unlocked list
    // (the middleware checks for those)
    app.use(securityMiddleware);
  } else if (options.locked) {
    // Secure only things matching the given prefixes, minus things
    // matching the insecure list
    if (typeof(options.locked) === 'string')
    {
      options.locked = [options.locked];
    }
    _.each(options.locked, function(prefix) {
      app.use(prefix, securityMiddleware);
    });
  } else {
    // No security by default (but logins work and you can check req.user yourself)
  }

  if (options.auth)
  {
    authStrategies[options.auth.strategy](options.auth.options);
  }

  app.get('/logout', function(req, res)
  {
    req.logOut();
    res.redirect('/');
  });

  callback(null);

  // Canonicalization is good for SEO and prevents user confusion,
  // Twitter auth problems in dev, etc.
  function canonicalizeHost(req, res, next)
  {
    if (req.headers.host !== options.host)
    {
      res.redirect(301, 'http://' + options.host + req.url);
    }
    else
    {
      next();
    }
  }
}

module.exports.listen = function() {
  // Default port for dev
  var port = 3000;
  // Heroku
  if (process.env.PORT) {
    port = process.env.PORT;
  } else {
    try {
      // Stagecoach option
      port = fs.readFileSync(__dirname + '/data/port', 'UTF-8').replace(/\s+$/, '');
    } catch (err) {
      console.log("I see no data/port file, defaulting to port " + port);
    }
  }
  console.log("Listening on port " + port);
  app.listen(port);
}


function securityMiddleware(req, res, next) {
  var i;
  for (i = 0; (i < options.unlocked.length); i++) {
    if (prefixMatch(options.unlocked[i], req.url)) {
      next();
      return;
    }
  }

  if (!req.user) {
    req.session.afterLogin = req.url;
    res.redirect(302, '/login');
    return;
  } else {
    next();
  }
}

// Match URL prefixes the same way Connect middleware does
function prefixMatch(prefix, url)
{
  var start = url.substr(0, prefix.length);
  if (prefix === start) {
    var c = url[prefix.length];
    if (c && ('/' != c) && ('.' != c) && ('?' != c)) {
      return false;
    }
    return true;
  }
  return false;
}

