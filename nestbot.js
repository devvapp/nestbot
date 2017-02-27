'use strict';

// Messenger API integration example
// We assume you have:
// * a Wit.ai bot setup (https://wit.ai/docs/quickstart)
// * a Messenger Platform setup (https://developers.facebook.com/docs/messenger-platform/quickstart)
// You need to `npm install` the following dependencies: body-parser, express, request.
//
// 1. npm install body-parser express request
// 2. Download and install ngrok from https://ngrok.com/download
// 3. ./ngrok http 8445
// 4. WIT_TOKEN=your_access_token FB_APP_SECRET=your_app_secret FB_PAGE_TOKEN=your_page_token node examples/messenger.js
// 5. Subscribe your page to the Webhooks using verify_token and `https://<your_ngrok_io>/webhook` as callback URL.
// 6. Talk to your bot on Messenger!

const bodyParser = require('body-parser');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const request = require('request');
const config = require('./config');
const util = require('util');
const hnews = require('hackernews-api');
var cache = require('memory-cache');

let Wit = null;
let log = null;
try {
  // if running from repo
  Wit = require('../').Wit;
  log = require('../').log;
} catch (e) {
  Wit = require('node-wit').Wit;
  log = require('node-wit').log;
}

// Webserver parameter
const PORT = config.PORT || 3000;

// Wit.ai parameters
const WIT_TOKEN = config.WIT_TOKEN;
if (!WIT_TOKEN) { throw new Error('missing WIT_TOKEN') }
// Messenger API parameters
const FB_PAGE_TOKEN = config.FB_PAGE_TOKEN;
if (!FB_PAGE_TOKEN) { throw new Error('missing FB_PAGE_TOKEN') }
const FB_APP_SECRET = config.FB_APP_SECRET;
if (!FB_APP_SECRET) { throw new Error('missing FB_APP_SECRET') }
const FB_VERIFY_TOKEN = config.FB_VERIFY_TOKEN;
if (!FB_VERIFY_TOKEN) { throw new Error('missing FB_VERIFY_TOKEN') }
const OPEN_WEATHER_API_KEY = config.OPEN_WEATHER_API_KEY;
if (!OPEN_WEATHER_API_KEY) { throw new Error('missing OPEN_WEATHER_API_KEY') }
const NEWS_API_KEY = config.NEWS_API_KEY;
if (!NEWS_API_KEY) { throw new Error('missing NEWS_API_KEY') }

const NEWS_SOURCE_IDS = 'news_source_ids';
const NEWS_SOURCES_URL = 'https://newsapi.org/v1/sources?language=en';
const NEWS_API_URL = 'https://newsapi.org/v1/articles?source=%s&apiKey=%s';

// ----------------------------------------------------------------------------
// Messenger API specific code

// See the Send API reference
// https://developers.facebook.com/docs/messenger-platform/send-api-reference

const fbMessage = (id, text) => {
  const body = JSON.stringify({
    recipient: { id },
    message: { text },
  });
  const qs = 'access_token=' + encodeURIComponent(FB_PAGE_TOKEN);
  return fetch('https://graph.facebook.com/me/messages?' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then(rsp => rsp.json())
    .then(json => {
      if (json.error && json.error.message) {
        throw new Error(json.error.message);
      }
      return json;
    });
};

// ----------------------------------------------------------------------------
// Wit.ai bot specific code

// This will contain all user sessions.
// Each session has an entry:
// sessionId -> {fbid: facebookUserId, context: sessionState}
const sessions = {};

const findOrCreateSession = (fbid) => {
  let sessionId;
  // Let's see if we already have a session for the user fbid
  Object.keys(sessions).forEach(k => {
    if (sessions[k].fbid === fbid) {
      // Yep, got it!
      sessionId = k;
    }
  });
  if (!sessionId) {
    // No session found for user fbid, let's create a new one
    sessionId = new Date().toISOString();
    sessions[sessionId] = { fbid: fbid, context: {} };
  }
  return sessionId;
};

var parseWeatherAPIResponse = function (data) {
  var weatherObj = JSON.parse(data);
  var forecast = weatherObj.weather[0].description;
  console.log('got data: ' + JSON.stringify(forecast));
  return forecast;
};

async function getWeatherByCity(city) {
  return new Promise((resolve, reject) => {
    //url = 'http://api.openweathermap.org/data/2.5/weather?q=London,uk&appid=xxxxxxxxxxx';
    const url = util.format('http://api.openweathermap.org/data/2.5/weather?q=%s&appid=%s', city, OPEN_WEATHER_API_KEY);
    request(url, function (error, response, body) {
      if (error) {
        return reject(error);
      }
      else if (response.statusCode == 200) {
        return resolve(body);
      }
    });
  });
};

async function getNextTopStoryFromHackerNews(next) {
  return new Promise((resolve, reject) => {
    const storyIds = hnews.getTopStories();
    //console.info('next : ', next);
    const jsonObj = hnews.getItem(storyIds[next]);
    //console.info('json : ', jsonObj);
    //var jsonObj = JSON.parse(json);
    var nextTopStory = jsonObj.title + " - " + jsonObj.url;
    return resolve(nextTopStory);
  });
};

var parseNewsAPISourcesResponse = function (data) {
  var sourcesDataObj = JSON.parse(data);
  var sources = sourcesDataObj.sources;
  var i, length, sourceIds = [],
  length = sources.length;
  for (i = 0; i < length; i++) {
     sourceIds.push(sources[i].id);
  }
  return sourceIds;
};

var parseNewsAPIResponse = function (data) {
  var newsObj = JSON.parse(data);
  var newsDescription = newsObj.articles[0].description;
  var newsUrl = newsObj.articles[0].url;
  console.log('got data: ' + JSON.stringify(newsDescription + " - " + newsUrl));
  return newsDescription + " - " + newsUrl;
};

//Generic Async method to make a get call.
async function getData(url) {
  return new Promise((resolve, reject) => {
    //const url = util.format('https://newsapi.org/v1/sources?language=en');
    request(url, function (error, response, body) {
      if (error) {
        return reject(error);
      }
      else if (response.statusCode == 200) {
        return resolve(body);
      }
    });
  });
};

function random (min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

const firstEntityValue = (entities, entity) => {
  const val = entities && entities[entity] &&
    Array.isArray(entities[entity]) &&
    entities[entity].length > 0 &&
    entities[entity][0].value
    ;
  if (!val) {
    return null;
  }
  return typeof val === 'object' ? val.value : val;
};

// Our bot actions
const actions = {
  send({sessionId}, {text}) {
    // Our bot has something to say!
    // Let's retrieve the Facebook user whose session belongs to
    const recipientId = sessions[sessionId].fbid;
    if (recipientId) {
      console.info('recipientId : ', recipientId);
      // We found our recipient! Let's forward our bot response to recipient.
      // We return a promise to let our bot know when we're done sending
      return fbMessage(recipientId, text)
        .then(() => null)
        .catch((err) => {
          console.error(
            'Oops! An error occurred while forwarding the response to',
            recipientId,
            ':',
            err.stack || err
          );
        });
    } else {
      console.error('Oops! Couldn\'t find user for session:', sessionId);
      // Giving the wheel back to our bot
      return Promise.resolve()
    }
  },
  //This action will get the news forecast
  async getForecast({context, entities}) {
    var location = firstEntityValue(entities, 'location');
    console.info('location : ', location);
    if (location) {
      //If the user send the location we will send the forecast.
      //Await till the api is returned back from the open api.
      var url = util.format('http://api.openweathermap.org/data/2.5/weather?q=%s&appid=%s', location, OPEN_WEATHER_API_KEY);
      var forecast = await getData(url);
      const weatherForecast = parseWeatherAPIResponse(forecast);
      context.forecast = weatherForecast + ' in ' + location;
      delete context.missingLocation;
    } else {
      //context.missingLocation = true;
      context.forecast = 'Please ask something like, \'How\'s weather in Chicago?\' or Weather in chicago? We currently get forecast only for present day.';
      //delete context.forecast;
    }
    return context;
  },
  //This action will get top news from hacker news
  async getNextTopNewsOnlyFromHackerNews({context, entities}) {
    var counter = 0;
    if (context.count) {
      counter = context.count;
    }
    //var counter = firstEntityValue(entities, 'count');
    console.info('Story # : ', counter);
    var story = await getNextTopStoryFromHackerNews(counter);
    context.count = ++counter;
    context.story = story;
    //context.nextStory = nextStory;
    return context;
  },
  //This action will get top news from hacker news
  async getNextTopNews({context, entities}) {
    var counter = 0;
    if (context.count) {
      counter = context.count;
    }
    var news_source_ids = cache.get(NEWS_SOURCE_IDS);
    if(!news_source_ids){
        var news_source_data = await getData(NEWS_SOURCES_URL);
        news_source_ids = parseNewsAPISourcesResponse(news_source_data);
        console.info('news_source_ids : ', news_source_ids);
        cache.put(NEWS_SOURCE_IDS, news_source_ids, 86400000, function(key, value) {
            console.log('Cached Expired... It will refresh the next time when an api call is made.');
        }); // Time in ms
    }
    console.info('Source # : ', counter);
    var source = news_source_ids[counter];
    console.info('source : ', source);
    const news_api_url = util.format(NEWS_API_URL, source, NEWS_API_KEY);
    var news_data = await getData(news_api_url);
    var story = parseNewsAPIResponse(news_data);
    //Send the counter values to Wit.ai as the counter for picking next random new sources top news.
    context.count = random(1,news_source_ids.length);
    context.story = story;
    return context;
  }
};

// Setting up our bot
const wit = new Wit({
  accessToken: WIT_TOKEN,
  actions,
  logger: new log.Logger(log.INFO)
});

// Starting our webserver and putting it all together
const app = express();
app.use(({method, url}, rsp, next) => {
  rsp.on('finish', () => {
    console.log(`${rsp.statusCode} ${method} ${url}`);
  });
  next();
});
app.use(bodyParser.json({ verify: verifyRequestSignature }));

// Webhook setup
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

// Message handler
app.post('/webhook', (req, res) => {
  // Parse the Messenger payload
  // See the Webhook reference
  // https://developers.facebook.com/docs/messenger-platform/webhook-reference
  const data = req.body;

  if (data.object === 'page') {
    data.entry.forEach(entry => {
      entry.messaging.forEach(event => {
        if (event.message && !event.message.is_echo) {
          // Yay! We got a new message!
          // We retrieve the Facebook user ID of the sender
          const sender = event.sender.id;

          // We retrieve the user's current session, or create one if it doesn't exist
          // This is needed for our bot to figure out the conversation history
          const sessionId = findOrCreateSession(sender);

          // We retrieve the message content
          const {text, attachments} = event.message;

          if (attachments) {
            // We received an attachment
            // Let's reply with an automatic message
            fbMessage(sender, 'Sorry I can only process text messages for now.')
              .catch(console.error);
          } else if (text) {
            // We received a text message

            // Let's forward the message to the Wit.ai Bot Engine
            // This will run all actions until our bot has nothing left to do
            wit.runActions(
              sessionId, // the user's current session
              text, // the user's message
              sessions[sessionId].context // the user's current session state
            ).then((context) => {
              // Our bot did everything it has to do.
              // Now it's waiting for further messages to proceed.
              console.log('Waiting for next user messages');

              // Based on the session state, you might want to reset the session.
              // This depends heavily on the business logic of your bot.
              // Example:
              // if (context['done']) {
              //   delete sessions[sessionId];
              // }

              // Updating the user's current session state
              sessions[sessionId].context = context;
            })
              .catch((err) => {
                console.error('Oops! Got an error from Wit: ', err.stack || err);
              })
          }
        } else {
          console.log('received event', JSON.stringify(event));
        }
      });
    });
  }
  res.sendStatus(200);
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
  * the App Dashboard, we can verify the signature that is sent with each
   * callback in the x-hub-signature field, located in the header.
    *
     * https://developers.facebook.com/docs/graph-api/webhooks#setup
      *
       */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', FB_APP_SECRET)
      .update(buf)
      .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

app.listen(PORT);
console.log('Listening on :' + PORT + '...');
