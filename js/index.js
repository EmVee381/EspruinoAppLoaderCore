let appJSON = []; // List of apps and info from apps.json
let appSortInfo = {}; // list of data to sort by, from appdates.csv { created, modified }
let appCounts = {};
let files = []; // list of files on the Espruimo Device
const DEFAULTSETTINGS = {
  pretokenise : true,
  minify : false,  // disabled by default due to https://github.com/espruino/BangleApps/pull/355#issuecomment-620124162
  favourites : ["launch"],
  language : "",
  bleCompat: false, // 20 byte MTU BLE Compatibility mode
  sendUsageStats: false  // send usage stats to banglejs.com
};
var SETTINGS = JSON.parse(JSON.stringify(DEFAULTSETTINGS)); // clone

let device = {
  id : undefined,     // The Espruino device ID of this device, eg. BANGLEJS
  version : undefined,// The Espruino firmware version, eg 2v08
  info : undefined,   // An entry from DEVICEINFO with information about this device
  connected : false,   // are we connected via BLE right now?
  appsInstalled : []  // list of app {id,version} of installed apps
};
// FOR TESTING ONLY
/*let LANGUAGE = {
  "//":"German language translations",
  "GLOBAL": {
    "//":"Translations that apply for all apps",
    "Alarm" : "Wecker",
    "Hours" : "Stunden",
    "Minutes" : "Minuten",
    "Enabled" : "Aktiviert",
    "Settings" : "Einstellungen"
  },
  "alarm": {
    "//":"App-specific overrides",
    "Alarm" : "Alarm"
  }
};*/
var LANGUAGE = undefined;

function appJSONLoadedHandler() {
  appJSON.forEach(app => {
    if (app.screenshots)
      app.screenshots.forEach(s => {
        if (s.url) s.url = "apps/"+app.id+"/"+s.url;
      });
  });
  var promise = Promise.resolve();
  if ("undefined" != typeof onAppJSONLoaded)
    promise = promise.then(onAppJSONLoaded);
  // finally update what we're showing
  promise.then(function() {
    refreshLibrary();
  });
}

httpGet(Const.APPS_JSON_FILE).then(apps=>{
  if (apps.startsWith("---")) {
    showToast(Const.APPS_JSON_FILE+" still contains Jekyll markup","warning");
    throw new Error("Not JSON");
  }
  try {
    appJSON = JSON.parse(apps);
  } catch(e) {
    console.log(e);
    showToast("App List Corrupted","error");
  }
  // fix up the JSON
  if (appJSON.length && appJSON[appJSON.length-1]===null)
    appJSON.pop(); // remove trailing null added to make auto-generation of apps.json easier
  appJSONLoadedHandler();
}).catch(error=>{
  console.warn("APPS FILE NOT FOUND "+Const.APPS_JSON_FILE);
  console.log("Attempting search - SLOW");
  let baseurl = window.location.href.replace(/\/[^\/]*$/,"/");
  let appsURL = baseurl+"apps";
  httpGet(appsURL).then(htmlText=>{
    showToast(Const.APPS_JSON_FILE+" can't be read, scanning 'apps' folder for apps","warning");
    var parser = new DOMParser();
    var xmlDoc = parser.parseFromString(htmlText,"text/html");
    appJSON = [];
    var promises = [];
    htmlToArray(xmlDoc.querySelectorAll("a")).forEach(a=>{
      var href = a.getAttribute("href");
      if (!href || href.startsWith("/") || href.startsWith("_") || !href.endsWith("/")) return;
      var metadataURL = appsURL+"/"+href+"metadata.json";
      console.log(" - Loading "+metadataURL);
      promises.push(httpGet(metadataURL).then(metadataText=>{
        try {
          appJSON.push(JSON.parse(metadataText));
        } catch(e) {
          console.log(e);
          showToast("App "+href+" metadata.json Corrupted","error");
        }
      }).catch(err=>{
        console.warn("App folder "+href+" has no metadata");
      }));
    });
    Promise.all(promises).then(appJSONLoadedHandler);
  }).catch(err=>{
    showToast(Const.APPS_JSON_FILE+" doesn't exist and cannot do directory listing on this server","error");
  });
});

if (Const.APP_DATES_CSV) httpGet(Const.APP_DATES_CSV).then(csv=>{
  // Firefox Date.parse doesn't understand our appdates.csv format
  function parseDate(datestamp) {
    // example: "2022-01-13 09:21:33 +0000"
    const [date, time, tz] = datestamp.split(" "),
      [year, month, day] = date.split("-"),
      [hours, minutes, seconds] = time.split(":");
    return new Date(year, month-1, day, hours, minutes, seconds);
  }
  csv.split("\n").forEach(line=>{
    let l = line.split(",");
    if (l.length<3) return;
    let key = l[0];
    if (appSortInfo[key]==undefined)
      appSortInfo[key] = {};
    appSortInfo[key].created = parseDate(l[1]);
    appSortInfo[key].modified = parseDate(l[2]);
  });
  document.querySelector(".sort-nav").classList.remove("hidden");
  document.querySelector(".sort-nav label[sortid='created']").classList.remove("hidden");
  document.querySelector(".sort-nav label[sortid='modified']").classList.remove("hidden");
}).catch(err=>{
  console.log("No recent.csv - app sort disabled");
});

if (Const.APP_USAGE_JSON) httpGet(Const.APP_USAGE_JSON).then(jsonTxt=>{
  var json;
  try {
    json = JSON.parse(jsonTxt);
  } catch (e) {
    console.warn("App usage JSON at "+Const.APP_USAGE_JSON+" couldn't be parsed");
    return;
  }
  appCounts.favs = 0;
  Object.keys(json.fav).forEach(key =>{
    if (appSortInfo[key]==undefined)
      appSortInfo[key] = {};
    if (json.fav[key] > appCounts.favs) appCounts.favs = json.fav[key];
    appSortInfo[key].favourites = json.fav[key];
  });
  appCounts.installs = 0;
  Object.keys(json.app).forEach(key =>{
    if (appSortInfo[key]==undefined)
      appSortInfo[key] = {};
    if (json.app[key] > appCounts.installs) appCounts.installs = json.app[key];
    appSortInfo[key].installs = json.app[key];
  });
  document.querySelector(".sort-nav").classList.remove("hidden");
  document.querySelector(".sort-nav label[sortid='installs']").classList.remove("hidden");
  document.querySelector(".sort-nav label[sortid='favourites']").classList.remove("hidden");
}).catch(err=>{
  console.log("No recent.csv - app sort disabled");
});

// ===========================================  Top Navigation
function showChangeLog(appid, installedVersion) {
  let app = appNameToApp(appid);
  function show(contents) {
    let shouldEscapeHtml = true;
    if (contents && installedVersion) {
      let lines = contents.split("\n");
      for(let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.startsWith(installedVersion)) {
          line = '<a id="' + installedVersion + '"></a>' + line;
          lines[i] = line;
        }
      }
      contents = lines.join("<br>");
      shouldEscapeHtml = false;
    }
    showPrompt(app.name+" ChangeLog",contents,{ok:true}, shouldEscapeHtml).catch(()=>{});
    if (installedVersion) {
      var elem = document.getElementById(installedVersion);
      if (elem) elem.scrollIntoView();
    }
  }
  httpGet(`apps/${appid}/ChangeLog`).
    then(show).catch(()=>show("No Change Log available"));
}
function showReadme(appid) {
  let app = appNameToApp(appid);
  let appPath = `apps/${appid}/`;
  let markedOptions = { baseUrl : appPath };
  function show(contents) {
    if (!contents) return;
    showPrompt(app.name + " Documentation", marked(contents, markedOptions), {ok: true}, false).catch(() => {});
  }
  httpGet(appPath+app.readme).then(show).catch(()=>show("Failed to load README."));
}
function getAppDescription(app) {
  let appPath = `apps/${app.id}/`;
  let markedOptions = { baseUrl : appPath };
  return marked(app.description, markedOptions);
}

/** Setup IFRAME callbacks for handleCustomApp and handleInterface */
function iframeSetup(options) {
  var iframe = options.iframe;
  var modal = options.modal;
  document.body.append(modal);
  htmlToArray(modal.getElementsByTagName("a")).forEach(button => {
    button.addEventListener("click",event => {
      event.preventDefault();
      modal.remove();
      if (options.onClose) options.onClose("Window closed");
    });
  });
  // when iframe is loaded, call 'onInit' with info about the device
  iframe.addEventListener("load", function() {
    console.log("IFRAME loaded");
    /* if we get a message from the iframe (eg asking to send data to Puck), handle it
    otherwise pass to messageHandler because handleCustomApp may want to handle it */
    iframe.contentWindow.addEventListener("message",function(event) {
      let msg = event.data;
      if (msg.type=="close") {
        modal.remove();
        if (options.onClose) options.onClose("Window closed");
      } else if (msg.type=="eval") {
        Puck.eval(msg.data, function(result) {
          iframe.contentWindow.postMessage({
            type : "evalrsp",
            data : result,
            id : msg.id
          });
        });
      } else if (msg.type=="write") {
        Puck.write(msg.data, function(result) {
          iframe.contentWindow.postMessage({
            type : "writersp",
            data : result,
            id : msg.id
          });
        });
      } else if (msg.type=="readstoragefile") {
        Comms.readStorageFile(msg.filename).then(function(result) {
          iframe.contentWindow.postMessage({
            type : "readstoragefilersp",
            data : result,
            id : msg.id
          });
        });
      } else if (msg.type=="readstorage") {
        Comms.readFile(msg.filename).then(function(result) {
          iframe.contentWindow.postMessage({
            type : "readstoragersp",
            data : result,
            id : msg.id
          });
        });
      } else if (msg.type=="writestorage") {
        Progress.show({title:`Uploading ${JSON.stringify(msg.filename)}`,sticky:true});
        Comms.writeFile(msg.filename, msg.data).then(function() {
          Progress.hide({sticky:true});
          iframe.contentWindow.postMessage({
            type : "writestoragersp",
            id : msg.id
          });
        });
      } else if (options.messageHandler) options.messageHandler(event);
    }, false);
    // send the 'init' message
    iframe.contentWindow.postMessage({
      type: "init",
      expectedInterface: options.jsFile,
      data: device
    },"*");
  }, false);
}

/** Create window for app customiser */
function handleCustomApp(appTemplate) {
  // Pops up an IFRAME that allows an app to be customised
  if (!appTemplate.custom) throw new Error("App doesn't have custom HTML");
  // if it needs a connection, do that first
  if (appTemplate.customConnect && !device.connected)
    return getInstalledApps().then(() => handleCustomApp(appTemplate));
  // otherwise continue
  return new Promise((resolve,reject) => {
    let modal = htmlElement(`<div class="modal active">
      <a href="#close" class="modal-overlay " aria-label="Close"></a>
      <div class="modal-container" style="height:100%">
        <div class="modal-header">
          <a href="#close" class="btn btn-clear float-right" aria-label="Close"></a>
          <div class="modal-title h5">${escapeHtml(appTemplate.name)}</div>
        </div>
        <div class="modal-body" style="height:100%">
          <div class="content" style="height:100%">
            <iframe src="apps/${appTemplate.id}/${appTemplate.custom}" style="width:100%;height:100%;border:0px;">
          </div>
        </div>
      </div>
    </div>`);
    let iframe = modal.getElementsByTagName("iframe")[0];
    iframeSetup({ iframe : iframe,
                  modal : modal,
                  jsFile : "customize.js",
                  onClose: reject,
                  messageHandler : function(event) {
      let msg = event.data;
      if (msg.type=="app") {
        let appFiles = msg.data;
        let app = JSON.parse(JSON.stringify(appTemplate)); // clone template
        // copy extra keys from appFiles
        Object.keys(appFiles).forEach(k => {
          if (k!="storage") app[k] = appFiles[k]
        });
        appFiles.storage.forEach(f => {
          app.storage = app.storage.filter(s=>s.name!=f.name); // remove existing item
          app.storage.push(f); // add new
        });
        console.log("Received custom app", app);
        modal.remove();

        getInstalledApps()
          .then(()=>checkDependencies(app))
          .then(()=>Comms.uploadApp(app,{device:device, language:LANGUAGE}))
          .then(()=>{
            Progress.hide({sticky:true});
            resolve();
          }).catch(err => {
            Progress.hide({sticky:true});
            reject('Upload failed, ' + err, 'error');
          });
      }
    }});
  });
}

/* Create window for app interface page */
function handleAppInterface(app) {
  // IFRAME interface window that can be used to get data from the app
  if (!app.interface) throw new Error("App doesn't have interface HTML");
  return new Promise((resolve,reject) => {
    let modal = htmlElement(`<div class="modal active">
      <a href="#close" class="modal-overlay " aria-label="Close"></a>
      <div class="modal-container" style="height:100%">
        <div class="modal-header">
          <a href="#close" class="btn btn-clear float-right" aria-label="Close"></a>
          <div class="modal-title h5">${escapeHtml(app.name)}</div>
        </div>
        <div class="modal-body" style="height:100%">
          <div class="content" style="height:100%">
            <iframe style="width:100%;height:100%;border:0px;">
          </div>
        </div>
      </div>
    </div>`);
    let iframe = modal.getElementsByTagName("iframe")[0];
    iframeSetup({ iframe : iframe,
                  modal : modal,
                  jsFile : "interface.js",
                  // onClose: reject, // we don't need to reject when the window is closed
                  messageHandler : function(event) {
      // nothing custom needed in here
    }});
    iframe.src = `apps/${app.id}/${app.interface}`;
  });
}

function changeAppFavourite(favourite, app) {
  if (favourite) {
    SETTINGS.favourites = SETTINGS.favourites.concat([app.id]);
  } else {
    SETTINGS.favourites = SETTINGS.favourites.filter(e => e != app.id);
  }
  saveSettings();
  refreshLibrary();
  refreshMyApps();
}

// ===========================================  Top Navigation
function showTab(tabname) {
  htmlToArray(document.querySelectorAll("#tab-navigate .tab-item")).forEach(tab => {
    tab.classList.remove("active");
  });
  htmlToArray(document.querySelectorAll(".apploader-tab")).forEach(tab => {
    tab.style.display = "none";
  });
  document.getElementById("tab-"+tabname).classList.add("active");
  document.getElementById(tabname).style.display = "inherit";
}

// =========================================== App Info

function getAppHTML(app, appInstalled, forInterface) {
  let version = getVersionInfo(app, appInstalled);
  let versionInfo = version.text;
  let versionTitle = '';
  let appFavourites;
  if (app.id in appSortInfo) {
    var infoTxt = [];
    var info = appSortInfo[app.id];
    if ("object"==typeof info.modified)
      infoTxt.push(`Last update: ${(info.modified.toLocaleDateString())}`);
    if (info.installs)
      infoTxt.push(`${info.installs} reported installs (${(info.installs / appCounts.installs * 100).toFixed(0)}%)`);
    if (info.favourites) {
      infoTxt.push(`${info.favourites} users favourited (${(info.favourites / appCounts.favs * 100).toFixed(0)}%)`);
      appFavourites = info.favourites;
    }
    if (infoTxt.length)
      versionTitle = `title="${infoTxt.join("\n")}"`;
  }
  if (versionInfo) versionInfo = ` <small ${versionTitle}>(${versionInfo})</small>`;
  let readme = `<a class="c-hand" onclick="showReadme('${app.id}')">Read more...</a>`;
  let favourite = SETTINGS.favourites.find(e => e == app.id);
  let githubLink = Const.APP_SOURCECODE_URL ?
    `<a href="${Const.APP_SOURCECODE_URL}/${app.id}" target="_blank" class="link-github"><img src="core/img/github-icon-sml.png" alt="See the code on GitHub"/></a>` : "";
  let appurl = window.location.origin + window.location.pathname + "?id=" + encodeURIComponent(app.id);

  let html = `<div class="tile column col-6 col-sm-12 col-xs-12 app-tile">
  <div class="tile-icon">
    <figure class="avatar"><img src="apps/${app.icon?`${app.id}/${app.icon}`:"unknown.png"}" alt="${escapeHtml(app.name)}"></figure><br/>
  </div>
  <div class="tile-content">
    <p class="tile-title text-bold"><a name="${appurl}"></a>${escapeHtml(app.name)} ${versionInfo}</p>
    <p class="tile-subtitle">${getAppDescription(app)}${app.readme?`<br/>${readme}`:""}</p>
    ${githubLink}
    <a href="${appurl}" class="link-copy-url" appid="${app.id}" title="Copy link to app" style="position:absolute;top: 56px;left: -24px;"><img src="core/img/copy-icon.png" alt="Copy link to app"/></a>
  </div>
  <div class="tile-action">`;
  if (forInterface=="library") html += `
    <button class="btn btn-link btn-action btn-lg btn-favourite" appid="${app.id}" title="Favourite"><i class="icon icon-favourite${favourite?" icon-favourite-active":""}">${appFavourites?`<span>${appFavourites}</span>`:""}</i></button>
    <button class="btn btn-link btn-action btn-lg ${(appInstalled&&app.interface)?"":"d-hide"}" appid="${app.id}" title="Download data from app"><i class="icon icon-interface"></i></button>
    <button class="btn btn-link btn-action btn-lg ${app.allow_emulator?"":"d-hide"}" appid="${app.id}" title="Try in Emulator"><i class="icon icon-emulator"></i></button>
    <button class="btn btn-link btn-action btn-lg ${version.canUpdate?"":"d-hide"}" appid="${app.id}" title="Update App"><i class="icon icon-refresh"></i></button>
    <button class="btn btn-link btn-action btn-lg ${(!appInstalled && !app.custom)?"":"d-hide"}" appid="${app.id}" title="Upload App"><i class="icon icon-upload"></i></button>
    <button class="btn btn-link btn-action btn-lg ${appInstalled?"":"d-hide"}" appid="${app.id}" title="Remove App"><i class="icon icon-delete"></i></button>
    <button class="btn btn-link btn-action btn-lg ${app.custom?"":"d-hide"}" appid="${app.id}" title="Customise and Upload App"><i class="icon icon-menu"></i></button>`;
  if (forInterface=="myapps") html += `
    <button class="btn btn-link btn-action btn-lg btn-favourite" appid="${app.id}" title="Favourite"><i class="icon icon-favourite${favourite?" icon-favourite-active":""}">${appFavourites?`<span>${appFavourites}</span>`:""}</i></button>
    <button class="btn btn-link btn-action btn-lg ${(appInstalled&&app.interface)?"":"d-hide"}" appid="${app.id}" title="Download data from app"><i class="icon icon-interface"></i></button>
    <button class="btn btn-link btn-action btn-lg ${version.canUpdate?'':'d-hide'}" appid="${app.id}" title="Update App"><i class="icon icon-refresh"></i></button>
    <button class="btn btn-link btn-action btn-lg" appid="${app.id}" title="Remove App"><i class="icon icon-delete"></i></button>`;
  html += "</div>";
  if (forInterface=="library") {
    var screenshots = (app.screenshots || []).filter(s=>s.url);
    if (screenshots.length)
      html += `<img class="tile-screenshot" appid="${app.id}" src="${screenshots[0].url}" alt="Screenshot"/>`;
  }
  return html+`</div>`;
}

// =========================================== Library

// Can't use chip.attributes.filterid.value here because Safari/Apple's WebView doesn't handle it
let chips = Array.from(document.querySelectorAll('.filter-nav .chip')).map(chip => chip.getAttribute("filterid"));

/*
 Filter types:
 .../BangleApps/#blue shows apps having "blue" in app.id or app.tag --> searchType:hash
 .../BangleApps/#bluetooth shows apps having "bluetooth" in app.id or app.tag (also selects bluetooth chip) --> searchType:chip
 .../BangleApps/id=antonclk shows app having app.id = antonclk --> searchType:id
 .../BangleApps/q=clock shows apps having "clock" in app.id or app.description --> searchType:full
 .../BangleApps/c=tool shows anything with keyword 'tool' (like cliking the 'Tools' chip) --> searchType:chip

  the input field does full search as well
*/


let activeSort = '';

// Update the sort state to match the current sort value
function refreshSort(){
  let sortContainer = document.querySelector("#librarycontainer .sort-nav");
  sortContainer.querySelector('.active').classList.remove('active');
  if(activeSort) sortContainer.querySelector('.chip[sortid="'+activeSort+'"]').classList.add('active');
  else sortContainer.querySelector('.chip[sortid]').classList.add('active');
}
// Refill the library with apps
function refreshLibrary(options) {
  options = options||{};
  let panelbody = document.querySelector("#librarycontainer .panel-body");
  // Work out what we should be filtering, based on the URL
  let searchType = ""; // possible values: hash, chip, full, id
  let searchValue = ""; // the actual value to search for

  if (window.location.hash) {
    searchValue = decodeURIComponent(window.location.hash.slice(1)).toLowerCase();
    searchType = "hash";
  }
  let searchParams = new URLSearchParams(window.location.search);
  if (window.location.search) {
    if (searchParams.has("id")) {
      searchValue = searchParams.get("id").toLowerCase();
      searchType = "id";
    }
    if (searchParams.has("q")) {
      searchValue = searchParams.get("q").toLowerCase();
      searchType = "full";
    }
    if (searchParams.has("c")) {
      searchValue = searchParams.get("c").toLowerCase();
      searchType = "chip";
    }
  }
  if (searchType === "hash" && chips.indexOf(searchValue)>=0)
    searchType = "chip";
  // Update the 'chips' to match the current window location
  let filtersContainer = document.querySelector("#librarycontainer .filter-nav");
  filtersContainer.querySelector('.active').classList.remove('active');
  if(searchType == "chip") {
    let hashFilter = filtersContainer.querySelector('.chip[filterid="'+searchValue+'"]');
    if (hashFilter) hashFilter.classList.add('active');
  } else filtersContainer.querySelector('.chip[filterid]').classList.add('active');
  // update the search box value
  if (!options.dontChangeSearchBox) {
    if (searchType === "full")
      librarySearchInput.value = searchValue;
    else
      librarySearchInput.value = "";
  }
  // Now filter according to what was set
  let visibleApps = appJSON.slice(); // clone so we don't mess with the original
  let sortedByRelevance = false;
  if (searchValue) {
    // Now do our search, put the values in searchResult
    let searchResult; // array of { app:app, relevance:number }
    if (searchType === "chip") {
      if (searchValue == "favourites") {
        searchResult = visibleApps.map(app => ({
          app : app,
          relevance : app.id?SETTINGS.favourites.filter(e => e == app.id).length:0
        }));
      } else {
        // Some chips represent a metadata "type" element:
        // - the "Clocks" chip must show only apps with "type": "clock"
        // - the "Widgets" chip must show only apps with "type": "widget"
        // and so on.
        // If the type is NOT in the array below then the search will be tag-based instead
        // of type-based.
        const supportedMetadataTypes = ["clock", "widget", "launch", "textinput", "ram"];
        searchResult = visibleApps.map(app => {
          if (app.type && supportedMetadataTypes.includes(app.type.toLowerCase())) {
            return { app:app, relevance:app.type.toLowerCase() == searchValue.toLowerCase() ? 1 : 0 }
          } else {
            return { app:app, relevance: (app.tags && app.tags.split(',').includes(searchValue)) ? 1 : 0 };
          }
        });
      }
    } else if (searchType === "hash") {
      sortedByRelevance = true;
      searchResult = visibleApps.map(app => ({
        app : app,
        relevance :
          searchRelevance(app.id, searchValue) +
          searchRelevance(app.name, searchValue) +
          (app.tags && app.tags.includes(searchValue))
        }));
    } else if (searchType === "id") {
      searchResult = visibleApps.map(app => ({
        app:app,
        relevance: (app.id.toLowerCase() == searchValue) ? 1 : 0
      }));
    } else if (searchType === "full" && searchValue) {
      sortedByRelevance = true;
      searchResult = visibleApps.map(app => ({
        app:app,
        relevance:
          searchRelevance(app.id, searchValue) +
          searchRelevance(app.name, searchValue)*(app.shortName?1:2) +
          (app.shortName?searchRelevance(app.shortName, searchValue):0) + // if we have shortname, match on that as well
          searchRelevance(app.description, searchValue)/5 + // match on description, but pay less attention
          ((app.tags && app.tags.includes(searchValue))?10:0)
        }));
    }
    // Now finally, filter, sort based on relevance and set the search result
    visibleApps = searchResult.filter(a => a.relevance>0).sort((a,b) => (b.relevance-(0|b.sortorder)) - (a.relevance-(0|a.sortorder))).map(a => a.app);
  }
  // if not otherwise sorted, use 'sort by' option
  if (!sortedByRelevance)
    visibleApps.sort(appSorter);

  if (activeSort) {
    if (["created","modified","installs","favourites"].includes(activeSort)) {
      visibleApps = visibleApps.sort((a,b) =>
         ((appSortInfo[b.id]||{})[activeSort]||0) -
         ((appSortInfo[a.id]||{})[activeSort]||0));
    } else throw new Error("Unknown sort type "+activeSort);
  }

  panelbody.innerHTML = visibleApps.map((app,idx) => {
    let appInstalled = device.appsInstalled.find(a=>a.id==app.id);
    return getAppHTML(app, appInstalled, "library");
  }).join("");
  // set badge up top
  let tab = document.querySelector("#tab-librarycontainer a");
  tab.classList.add("badge");
  tab.setAttribute("data-badge", appJSON.length);
  htmlToArray(panelbody.getElementsByTagName("button")).forEach(button => {
    button.addEventListener("click",event => {
      let button = event.currentTarget;
      let icon = button.firstChild;
      let appid = button.getAttribute("appid");
      let app = appNameToApp(appid);
      if (!app) throw new Error("App "+appid+" not found");
      // check icon to figure out what we should do
      if (icon.classList.contains("icon-emulator")) {
        // emulator
        let file = app.storage.find(f=>f.name.endsWith('.js'));
        if (!file) {
          console.error("No entrypoint found for "+appid);
          return;
        }
        let baseurl = window.location.href.replace(/\/[^\/]*$/,"/");
        baseurl = baseurl.substr(0,baseurl.lastIndexOf("/"));
        let url = baseurl+"/apps/"+app.id+"/"+file.url;
        window.open(`https://espruino.com/ide/emulator.html?codeurl=${url}&upload`);
      } else if (icon.classList.contains("icon-upload")) {
        // upload
        icon.classList.remove("icon-upload");
        icon.classList.add("loading");
        uploadApp(app);
      } else if (icon.classList.contains("icon-menu")) {
        // custom HTML update
        icon.classList.remove("icon-menu");
        icon.classList.add("loading");
        customApp(app);
      } else if (icon.classList.contains("icon-delete")) {
        // Remove app
        icon.classList.remove("icon-delete");
        icon.classList.add("loading");
        removeApp(app);
      } else if (icon.classList.contains("icon-refresh")) {
        // Update app
        icon.classList.remove("icon-refresh");
        icon.classList.add("loading");
        updateApp(app);
      } else if (icon.classList.contains("icon-interface")) {
        handleAppInterface(app);
      } else if ( button.classList.contains("btn-favourite")) {
        let favourite = SETTINGS.favourites.find(e => e == app.id);
        changeAppFavourite(!favourite, app);
      }
    });
  });
  htmlToArray(panelbody.getElementsByClassName("tile-screenshot")).forEach(screenshot => {
    screenshot.addEventListener("click",event => {
      let icon = event.currentTarget;
      let appid = icon.getAttribute("appid");
      showScreenshots(appid);
    });
  });
  htmlToArray(panelbody.getElementsByClassName("link-copy-url")).forEach(link => {
    link.addEventListener("click",event => {
      event.preventDefault();
      let link = event.currentTarget;
      let appid = link.getAttribute("appid");
      let app = appNameToApp(appid);
      if (!app) throw new Error("App "+appid+" not found");
      const url = window.location.origin + window.location.pathname + "?id=" + appid;
      navigator.clipboard.writeText(url).then(function() {
        showToast("Link to app " + app.name + " copied to clipboard.","success");
      }, function(err) {
        console.error('Could not copy link to clipboard.', err);
      });
    });
  });
}

function showScreenshots(appId) {
  let app = appJSON.find(app=>app.id==appId);
  if (!app || !app.screenshots) return;
  var screenshots = app.screenshots.filter(s=>s.url);
  showPrompt(app.name+" Screenshots",`<div class="columns">
    ${screenshots.map(s=>`
    <div class="column col-4">
      <div class="card">
        <div class="card-image">
          <img src="${s.url}" alt="Screenshot" class="img-responsive">
        </div>
      </div>
    </div>`).join("\n")}
  </div>`,{ok:true},false);
}

// =========================================== My Apps

function uploadApp(app) {
  return getInstalledApps().then(()=>{
    if (device.appsInstalled.some(i => i.id === app.id)) {
      return updateApp(app);
    }
    checkDependencies(app)
      .then(()=>Comms.uploadApp(app,{device:device, language:LANGUAGE}))
      .then((appJSON) => {
        Progress.hide({ sticky: true });
        if (appJSON) {
          device.appsInstalled.push(appJSON);
        }
        showToast(app.name + ' Uploaded!', 'success');
      }).catch(err => {
        Progress.hide({ sticky: true });
        showToast('Upload failed, ' + err, 'error');
      }).finally(()=>{
        refreshMyApps();
        refreshLibrary();
      });
  }).catch(err => {
    showToast("Device connection failed, "+err,"error");
    // remove loading indicator
    refreshMyApps();
    refreshLibrary();
  });
}

function removeApp(app) {
  return showPrompt("Delete","Really remove '"+app.name+"'?").then(() => {
    return getInstalledApps().then(()=>{
      // a = from appid.info, app = from apps.json
      return Comms.removeApp(device.appsInstalled.find(a => a.id === app.id));
    });
  }).then(()=>{
    device.appsInstalled = device.appsInstalled.filter(a=>a.id!=app.id);
    showToast(app.name+" removed successfully","success");
    refreshMyApps();
    refreshLibrary();
  }, err=>{
    showToast(app.name+" removal failed, "+err,"error");
  });
}

function customApp(app) {
  return handleCustomApp(app).then((appJSON) => {
    if (appJSON) device.appsInstalled.push(appJSON);
    showToast(app.name+" Uploaded!", "success");
    refreshMyApps();
    refreshLibrary();
  }).catch(err => {
    showToast("Customise failed, "+err, "error");
    refreshMyApps();
    refreshLibrary();
  });
}

/* check for dependencies the app needs and install them if required
uploadOptions is an object, see AppInfo.checkDependencies for what can be in it
*/
function checkDependencies(app, uploadOptions) {
  uploadOptions = uploadOptions||{};
  uploadOptions.apps = appJSON;
  uploadOptions.device = device;
  uploadOptions.language = LANGUAGE;
  uploadOptions.showQuery = function(msg, appToRemove) {
    return new Promise((resolve,reject) => {
      let modal = htmlElement(`<div class="modal active">
        <a href="#close" class="modal-overlay " aria-label="Close"></a>
        <div class="modal-container">
          <div class="modal-header">
            <a href="#close" class="btn btn-clear float-right" aria-label="Close"></a>
            <div class="modal-title h5">App Dependencies</div>
          </div>
          <div class="modal-body">
            <div class="content">
              ${msg}. What would you like to do?
            </div>
          </div>
          <div class="modal-footer">
            <a href="#" class="btn btn-primary btn-replace" btnType="replace">Replace</a>
            <a href="#" class="btn btn-cancel">Cancel</a>
            <a href="#" class="btn btn-keep">Keep Both</a>
          </div>
        </div>
      </div>`);
      document.body.append(modal);
      htmlToArray(modal.getElementsByTagName("a")).forEach(button => {
        button.addEventListener("click",event => {
          event.preventDefault();
          modal.remove();
          if (event.target.classList.contains("btn-replace")) {
            // replace the old one - just remove it
            Comms.removeApp(appToRemove).then(() => {
              device.appsInstalled = device.appsInstalled.filter(a=>a.id!=appToRemove.id);
              resolve()
            });
          } else if (event.target.classList.contains("btn-keep")) {
            // Keep both - we'll just continue as-is
            resolve();
          } else { // was probably close/cancel
            reject("User cancelled");
          }
        });
      });
    });
  };
  uploadOptions.needsApp = (app,uploadOptions) => Comms.uploadApp(app,uploadOptions);
  return AppInfo.checkDependencies(app, device, uploadOptions);
}

/* Update an app to latest version.
if options.noReset is true, don't reset the device before
if options.noFinish is true, showUploadFinished isn't called (displaying the reboot message) */
function updateApp(app, options) {
  options = options||{};
  if (app.custom) return customApp(app);
  return Comms.getAppInfo(app).then(remove => {
    // remove = from appid.info, app = from apps.json
    if (remove.files===undefined) remove.files="";
    // no need to remove files which will be overwritten anyway
    remove.files = remove.files.split(',')
      .filter(f => f !== app.id + '.info')
      .filter(f => !app.storage.some(s => s.name === f))
      .join(',');
    let data = AppInfo.parseDataString(remove.data)
    if ('data' in app) {
      // only remove data files which are no longer declared in new app version
      const removeData = (f) => !app.data.some(d => (d.name || d.wildcard)===f)
      data.dataFiles = data.dataFiles.filter(removeData)
      data.storageFiles = data.storageFiles.filter(removeData)
    }
    remove.data = AppInfo.makeDataString(data)
    return Comms.removeApp(remove, {containsFileList:true, noReset:options.noReset, noFinish:options.noFinish});
  }).then(()=>{
    showToast(`Updating ${app.name}...`);
    device.appsInstalled = device.appsInstalled.filter(a=>a.id!=app.id);
    return checkDependencies(app,{checkForClashes:false});
  }).then(()=>Comms.uploadApp(app,{device:device,noReset:options.noReset, noFinish:options.noFinish})
  ).then((appJSON) => {
    if (appJSON) device.appsInstalled.push(appJSON);
    showToast(app.name+" Updated!", "success");
    refreshMyApps();
    refreshLibrary();
  }, err=>{
    showToast(app.name+" update failed, "+err,"error");
    refreshMyApps();
    refreshLibrary();
  });
}



function appNameToApp(appName) {
  let app = appJSON.find(app=>app.id==appName);
  if (app) return app;
  /* If app not known, add just one file
  which is the JSON - so we'll remove it from
  the menu but may not get rid of all files. */
  return { id: appName,
    name: "Unknown app "+appName,
    icon: "../unknown.png",
    description: "Unknown app",
    storage: [ {name:appName+".info"}],
    unknown: true,
  };
}

function showLoadingIndicator(id) {
  let panelbody = document.querySelector(`#${id} .panel-body`);
  let tab = document.querySelector(`#tab-${id} a`);
  // set badge up top
  tab.classList.add("badge");
  tab.setAttribute("data-badge", "");
  // Loading indicator
  panelbody.innerHTML = '<div class="tile column col-12"><div class="tile-content" style="min-height:48px;"><div class="loading loading-lg"></div></div></div>';
}

function getAppsToUpdate(options) {
  options = options || {}; // excludeCustomApps
  let appsToUpdate = [];
  device.appsInstalled.forEach(appInstalled => {
    let app = appNameToApp(appInstalled.id);
    appInstalled.canUpdate = isAppUpdateable(appInstalled, app) && (!options.excludeCustomApps || app.custom === undefined);
    if (appInstalled.canUpdate) {
      appsToUpdate.push(app);
    }
  });
  return appsToUpdate;
}

function refreshMyApps() {
  // if we've got a callback, call it first
  if ("function"==typeof onRefreshMyApps)
    onRefreshMyApps();
  // Now update...
  let panelbody = document.querySelector("#myappscontainer .panel-body");
  let appsToUpdate = getAppsToUpdate(); // this writes canUpdate attributes to apps in device.appsInstalled
  panelbody.innerHTML = device.appsInstalled.sort(appSorterUpdatesFirst).map(appInstalled => {
    let app = appNameToApp(appInstalled.id);
    return getAppHTML(app, appInstalled, "myapps");
  }).join("");
  htmlToArray(panelbody.getElementsByTagName("button")).forEach(button => {
    button.addEventListener("click",event => {
      let button = event.currentTarget;
      let icon = button.firstChild;
      let appid = button.getAttribute("appid");
      let app = appNameToApp(appid);
      if (!app) throw new Error("App "+appid+" not found");
      // check icon to figure out what we should do
      if (icon.classList.contains("icon-delete")) removeApp(app);
      if (icon.classList.contains("icon-refresh")) updateApp(app);
      if (icon.classList.contains("icon-interface")) handleAppInterface(app);
      if (icon.classList.contains("icon-favourite")) {
          let favourite = SETTINGS.favourites.find(e => e == app.id);
          changeAppFavourite(!favourite, app);
      }
    });
  });
  let nonCustomAppsToUpdate = getAppsToUpdate({excludeCustomApps:true});
  let tab = document.querySelector("#tab-myappscontainer a");
  let updateApps = document.querySelector("#myappscontainer .updateapps");
  if (nonCustomAppsToUpdate.length) {
    updateApps.innerHTML = `Update ${nonCustomAppsToUpdate.length} apps`;
    updateApps.classList.remove("hidden");
    updateApps.classList.remove("disabled");
    tab.setAttribute("data-badge", `${device.appsInstalled.length} ⬆${nonCustomAppsToUpdate.length}`);
  } else if (appsToUpdate.length) {
    updateApps.classList.add("disabled");
    updateApps.classList.remove("hidden");
    updateApps.innerHTML = `${appsToUpdate.length} custom app needs manual update`;
  } else {
    updateApps.classList.add("hidden");
    updateApps.classList.remove("disabled");
    tab.setAttribute("data-badge", device.appsInstalled.length);
  }
}

let haveInstalledApps = false;
function getInstalledApps(refresh) {
  if (haveInstalledApps && !refresh) {
    return Promise.resolve(device.appsInstalled);
  }
  showLoadingIndicator("myappscontainer");
  // Get apps and files
  return Comms.getDeviceInfo()
    .then(info => {
      device.uid = info.uid;
      device.id = info.id;
      device.version = info.version;
      device.appsInstalled = info.apps;
      haveInstalledApps = true;
      if ("function"==typeof onFoundDeviceInfo)
        onFoundDeviceInfo(device.id, device.version);
      device.info = DEVICEINFO.find(d=>d.id==device.id);
      refreshMyApps();
      refreshLibrary();
      // if the time is obviously wrong, set it up!
      console.log("Current device time is "+new Date(info.currentTime));
      if (info.currentTime < new Date("2000").getTime()) {
        console.log("Time is not set - updating it.");
        return Comms.setTime();
      }
      if (SETTINGS["settime"] && Math.abs(Date.now()-info.currentTime)>2000) {
        console.log("SETTINGS.settime=true and >2 seconds out - updating time");
        return Comms.setTime();
      }
      // Show device info in more page:
      const deviceInfoElem = document.getElementById("more-deviceinfo");
      if (deviceInfoElem) {
        deviceInfoElem.style.display = "inherit";
        const deviceInfoContentElem = document.getElementById("more-deviceinfo-content");
        deviceInfoContentElem.innerHTML = `
<table class="table"><tbody>
  <tr><td><b>Device Type</b></td><td>${device.id}</td></tr>
  <tr><td><b>Firmware Version</b></td><td>${device.version}</td></tr>
  <tr><td><b>Apps Installed</b></td><td>${(device.appsInstalled || []).map(a => `${a.id} (${a.version})`).join(", ")}</td></tr>
</tbody></table>`;
      }
    })
    .then(() => handleConnectionChange(true))
    .then(() => device.appsInstalled);
}

/// Removes everything and install the given apps, eg: installMultipleApps(["boot","mclock"], "minimal")
function installMultipleApps(appIds, promptName) {
  let apps = appIds.map( appid => appJSON.find(app=>app.id==appid) );
  if (apps.some(x=>x===undefined))
    return Promise.reject("Not all apps found, missing "+appIds.filter(appid => appJSON.find(app=>app.id==appid)===undefined ).join(","));
  let appCount = apps.length;
  return showPrompt("Install Defaults",`Remove everything and install ${promptName} apps?`).then(() => {
    return Comms.removeAllApps();
  }).then(()=>{
    Progress.hide({sticky:true});
    device.appsInstalled = [];
    showToast(`Existing apps removed. Installing  ${appCount} apps...`);
    return new Promise((resolve,reject) => {
      function upload() {
        let app = apps.shift();
        if (app===undefined) return resolve();
        Progress.show({title:`${app.name} (${appCount-apps.length}/${appCount})`,sticky:true});
        checkDependencies(app,{device:device, noReset:true, noFinish:true})
          .then(()=>Comms.uploadApp(app,{device:device, noReset:true, noFinish:true}))
          .then((appJSON) => {
            Progress.hide({sticky:true});
            if (appJSON) device.appsInstalled.push(appJSON);
            showToast(`(${appCount-apps.length}/${appCount}) ${app.name} Uploaded`);
            upload();
          }).catch(function() {
            Progress.hide({sticky:true});
            reject();
          });
      }
      upload();
    });
  }).then(()=> Comms.setTime()
  ).then(()=> Comms.showUploadFinished()
  ).then(()=>{
    showToast("Apps successfully installed!","success");
    return getInstalledApps(true);
  });
}

function updateAllApps() {
  let appsToUpdate = getAppsToUpdate({excludeCustomApps:true});
  // get apps - don't auto-update custom apps since they need the
  // customiser page running
  let count = appsToUpdate.length;
  if (!count) {
    showToast("Update failed, no apps can be updated","error");
    return;
  }
  function updater() {
    if (!appsToUpdate.length) return Promise.resolve("Success");
    let app = appsToUpdate.pop();
    return updateApp(app, {noReset:true,noFinish:true}).then(function() {
      return updater();
    });
  }
  Comms.reset().then(_ =>
    updater()
  ).then(_ =>
    Comms.showUploadFinished()
  ).then(_ => {
    showToast(`Updated ${count} apps`,"success");
  }).catch(err => {
    showToast("Update failed, "+err,"error");
  });
}

let connectMyDeviceBtn = document.getElementById("connectmydevice");

function handleConnectionChange(connected) {
  device.connected = connected;
  connectMyDeviceBtn.textContent = connected ? 'Disconnect' : 'Connect';
  connectMyDeviceBtn.classList.toggle('is-connected', connected);
  if (!connected) {
    haveInstalledApps = false;
    device.appsInstalled = [];
    refreshMyApps();
    refreshLibrary();
  }
}

htmlToArray(document.querySelectorAll(".btn.refresh")).map(button => button.addEventListener("click", () => {
  getInstalledApps(true).catch(err => {
    showToast("Getting app list failed, "+err,"error");
  });
}));
htmlToArray(document.querySelectorAll(".btn.updateapps")).map(button => button.addEventListener("click", () => {
  updateAllApps();
}));
connectMyDeviceBtn.addEventListener("click", () => {
  if (connectMyDeviceBtn.classList.contains('is-connected')) {
    Comms.disconnectDevice();
    const deviceInfoElem = document.getElementById("more-deviceinfo");
    if (deviceInfoElem) deviceInfoElem.style.display = "none";
  } else {
    getInstalledApps(true).catch(err => {
      showToast("Device connection failed, "+err,"error");
    });
  }
});
Comms.watchConnectionChange(handleConnectionChange);

// Handle the 'chips'
let filtersContainer = document.querySelector("#librarycontainer .filter-nav");
filtersContainer.addEventListener('click', ({ target }) => {
  if (target.classList.contains('active')) return;

  var filterName = target.getAttribute('filterid') || '';
  // Update window URL
  window.history.replaceState(null, null, "?c=" + filterName);
  refreshLibrary();
});

let librarySearchInput = document.querySelector("#searchform input");
const searchInputChangedDebounced = debounce(function() {
  refreshLibrary({dontChangeSearchBox:true});
}, 300);
librarySearchInput.addEventListener('input', evt => {
  var searchValue = evt.target.value.toLowerCase();
  // Update window URL
  window.history.replaceState(null, null, "?q=" + searchValue);
  searchInputChangedDebounced();
});

let sortContainer = document.querySelector("#librarycontainer .sort-nav");
sortContainer.addEventListener('click', ({ target }) => {
  if (target.classList.contains('active')) return;
  activeSort = target.getAttribute('sortid') || '';
  refreshSort();
  refreshLibrary();
});

// =========================================== About

// Settings
let SETTINGS_HOOKS = {}; // stuff to get called when a setting is loaded
/// Load settings and update controls
function loadSettings() {
  let j = localStorage.getItem("settings");
  if (typeof j != "string") return;
  try {
    let s = JSON.parse(j);
    Object.keys(s).forEach( k => {
      SETTINGS[k]=s[k];
      if (SETTINGS_HOOKS[k]) SETTINGS_HOOKS[k]();
    } );
  } catch (e) {
    console.error("Invalid settings");
  }
}
/// Save settings
function saveSettings() {
  localStorage.setItem("settings", JSON.stringify(SETTINGS));
  console.log("Changed settings", SETTINGS);
}
// Link in settings DOM elements
function settingsCheckbox(id, name) {
  let setting = document.getElementById(id);
  if (setting===null) return; // no setting found
  function update() {
    setting.checked = SETTINGS[name];
  }
  SETTINGS_HOOKS[name] = update;
  setting.addEventListener('click', function() {
    SETTINGS[name] = setting.checked;
    saveSettings();
  });
}
settingsCheckbox("settings-pretokenise", "pretokenise");
settingsCheckbox("settings-minify", "minify");
settingsCheckbox("settings-settime", "settime");
loadSettings();

let btn;

btn = document.getElementById("defaultsettings");
if (btn) btn.addEventListener("click",event=>{
  SETTINGS = JSON.parse(JSON.stringify(DEFAULTSETTINGS)); // clone
  saveSettings();
  loadSettings(); // update all settings
  refreshLibrary(); // favourites were in settings
});

btn = document.getElementById("resetwatch");
if (btn) btn.addEventListener("click",event=>{
  Comms.resetDevice().then(()=>{
    showToast("Reset watch successfully","success");
  }, err=>{
    showToast("Error resetting watch: "+err,"error");
  });
});
btn = document.getElementById("settime");
if (btn) btn.addEventListener("click",event=>{
  Comms.setTime().then(()=>{
    showToast("Time set successfully","success");
  }, err=>{
    showToast("Error setting time, "+err,"error");
  });
});
btn = document.getElementById("removeall");
if (btn) btn.addEventListener("click",event=>{
  showPrompt("Remove All","Really remove all apps?").then(() => {
    return Comms.removeAllApps();
  }).then(()=>{
    Progress.hide({sticky:true});
    device.appsInstalled = [];
    showToast("All apps removed","success");
    return getInstalledApps(true);
  }).catch(err=>{
    Progress.hide({sticky:true});
    showToast("App removal failed, "+err,"error");
  });
});

// Install all favourite apps in one go
btn = document.getElementById("installfavourite");
if (btn) btn.addEventListener("click",event=>{
    let nonCustomFavourites = SETTINGS.favourites.filter(appId => appJSON.find(app => app.id === appId && !app.custom));
    const mustHave = [ "boot","setting" ]; // apps that we absolutely need installed
    mustHave.forEach(id => {
      if (!nonCustomFavourites.includes(id))
        nonCustomFavourites.unshift(id);
    });
    installMultipleApps(nonCustomFavourites, "favourite").catch(err=>{
    Progress.hide({sticky:true});
    showToast("App Install failed, "+err,"error");
  });
});

// Create a new issue on github
btn = document.getElementById("newGithubIssue");
if (btn) btn.addEventListener("click", event => {
  const urlTemplate = "https://github.com/espruino/BangleApps/issues/new?template=bangle-bug-report-custom-form.yaml&fwversion={version}&apps={apps}";
  const apps = (device.appsInstalled || []).map(a => `${a.id} (${a.version})`).join("\n");
  const version = device.connected ? device.version : "";

  const url = urlTemplate.replace("{version}", encodeURIComponent(version)).replace("{apps}", encodeURIComponent(apps));

  window.open(url, '_blank');
});
