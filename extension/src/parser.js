export const TIMELINE_SELECTOR = ".userContentWrapper";
export const SIDEBAR_SELECTOR = ".ego_unit";
export const DEBUG =
  process.env.NODE_ENV === "dev" || process.env.NODE_ENV === "development";

const adCache = new Map();
const targetingCache = new Map();
let targetingBlocked = false;

// create an ad for sending
const ad = node => ({
  html: cleanAd(node.outerHTML),
  created_at: new Date().toString()
});

class StateMachine {
  constructor() {
    this.states = [];
  }

  tick() {
    throw "Unimplemented!";
  }

  promote(state, message = "") {
    this.states.push(state);
    this.state = state;
    this.message = message;
  }
}

// This is a simple state machine that aims to get rid of the promise mess of before in favor of a
// tick based approach. It should help us reason about the flow and transition states. And allow for
// easier testing
export const states = {
  INITIAL: "INITIAL",
  TIMELINE: "TIMELINE",
  TIMELINE_ID: "TIMELINE_ID",
  SIDEBAR: "SIDEBAR",
  SIDEBAR_ID: "SIDEBAR_ID",
  CACHED: "CACHED",
  TARGETING: "TARGETING",
  WAIT_TARGETING: "WAIT_TARGETING",
  OPEN: "OPEN",
  MENU: "MENU",
  DONE: "DONE",
  ERROR: "ERROR"
};
export const errors = {
  NOT_AN_AD: "Not an ad",
  TIMEOUT: "Timeout transitioning states",
  NO_TOGGLE: "Couldn't find a toggle",
  INVARIANT: "Impossible state, BUG!",
  NO_ID: "Couldn't find the ad's id"
};
const TIMEOUT = 10000;
const POLL = 50;
export class Parser extends StateMachine {
  constructor(node, resolve, reject) {
    super();
    this.state = states.INITIAL;
    this.node = node;
    this.resolve = resolve;
    this.reject = reject;
  }

  start() {
    this.timer = setInterval(() => this.tick(), POLL);
    // cleanup after ourselves if we have been stuck for TIMEOUT millis
    this.timeout = setTimeout(() => {
      if (this.state !== states.DONE) {
        this.promote(states.ERROR, errors.TIMEOUT);
      }
    }, TIMEOUT);
  }

  stop() {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.timer) clearInterval(this.timer);
  }

  tick() {
    switch (this.state) {
      case states.INITIAL:
        this.parse();
        break;
      case states.TIMELINE:
        this.timeline();
        break;
      case states.TIMELINE_ID:
        this.timelineId();
        break;
      case states.SIDEBAR:
        this.sidebar();
        break;
      case states.SIDEBAR_ID:
        this.sidebarId();
        break;
      case states.CACHED:
        this.cached();
        break;
      case states.OPEN:
        this.open();
        break;
      case states.MENU:
        this.menu();
        break;
      case states.TARGETING:
        this.targeting();
        break;
      case states.WAIT_TARGETING:
        this.waitTargeting();
        break;
      case states.ERROR:
        this.error();
        break;
      case states.DONE:
        this.done();
        break;
      default:
        this.promote(states.ERROR, errors.INVARIANT);
        break;
    }
  }

  parse() {
    const list = this.node.classList;
    if (list.contains("userContentWrapper") || list.contains("_5pcr")) {
      this.promote(states.TIMELINE);
    } else if (list.contains("ego_unit")) {
      this.promote(states.SIDEBAR);
    } else {
      this.promote(states.ERROR, errors.NOT_AN_AD);
    }
  }

  timeline() {
    const sponsor = checkSponsor(this.node);
    // First we check if it is actually a sponsored post
    if (!sponsor) return this.notAnAd();

    // And then we try to grab the parent container that has a hyperfeed id
    let parent = this.node;
    while (parent) {
      let id = parent.getAttribute("id");
      if (id && id.startsWith("hyperfeed")) break;
      parent = parent.parentElement;
    }

    // If we've walked off the top of the parent heirarchy that's an error
    if (!parent) return this.notAnAd();

    // Also if there's nothing to save that's an error
    if (this.node.children.length === 0) return this.notAnAd();

    // Check to see that we have the innermost fbUserContent, this cuts out like's
    // and shares.
    if (this.node.querySelector(TIMELINE_SELECTOR))
      this.node = this.node.querySelector(TIMELINE_SELECTOR);

    if (DEBUG) parent.style.color = "#006304";
    this.ad = ad(this.node);
    this.parent = parent;
    this.promote(states.TIMELINE_ID);
  }

  sidebar() {
    // First we still need to make sure we are in a sponsored box;
    let parent = this.node;
    while (parent) {
      if (checkSponsor(parent)) break;
      parent = parent.parentElement;
    }

    // As before it is an error if we haven't found a sponsor node.
    if (
      !(parent && parent.classList && parent.classList.contains("ego_section"))
    ) {
      return this.notAnAd();
    }
    // Sanity check to make sure we have a salvageable id
    if (!this.node.hasAttribute("data-ego-fbid")) {
      return this.notAnAd();
    }
    // and we have childnodes
    if (!this.node.children.length === 0) return this.notAnAd();
    if (DEBUG) parent.style.color = "#f442c8";
    this.ad = ad(this.node);
    this.parent = parent;
    // Move onto the next step
    this.promote(states.SIDEBAR_ID);
  }

  cached() {
    if (adCache.has(this.toggleId)) {
      this.ad = adCache.get(this.toggleId);
      this.promote(states.DONE);
    } else {
      this.promote(states.ERROR, errors.INVARIANT);
    }
  }

  // these next two should be refactored into mini state machines
  timelineId() {
    const control = this.parent.querySelector(".uiPopover");
    if (!control && control.id === "")
      return this.promote(states.ERROR, errors.NO_TOGGLE);
    const toggle = control.querySelector("a");
    if (!toggle) return this.promote(states.ERROR, errors.NO_TOGGLE);
    this.toggleId = toggle.id;
    if (adCache.has(toggle.id)) return this.promote(states.CACHED);
    // build out our state for the next step.
    this.idFinder = new TimelineFinder(toggle.id, toggle);
    this.promote(states.MENU);
  }

  // Similar to the above -- while we could just use the data-ego-fbid from before, it makes sense
  // to use the one in the encoded url in case that the dom one goes away.
  sidebarId() {
    const control = this.node.querySelector(".uiSelector");
    if (!control) return this.promote(states.ERROR, errors.NO_TOGGLE);
    // Since the sidebar DOM structure is slightly different we need to pull out
    // the toggle Id from the data-gt attribute.
    const toggle = control.querySelector("a");
    if (!toggle) return this.promote(states.ERROR, errors.NO_TOGGLE);

    // Twitter ad IDs are too big to store as JavaScript integers
    //   const toggleData = JSON.parse(toggle.getAttribute("data-gt"));
    //   if (!toggleData["data_to_log"])
    //     return this.promote(states.ERROR, errors.NO_TOGGLE);
    //   const toggleId = toggleData["data_to_log"]["ad_id"];
    // what's below is the same as above, but via string manipulation
    // so the integer doesn't get truncated.
    const ad_id_start =
      toggle.getAttribute("data-gt").indexOf("&quot;ad_id&quot;:") > -1
        ? toggle.getAttribute("data-gt").indexOf("&quot;ad_id&quot;:") + 18
        : toggle.getAttribute("data-gt").indexOf("\"ad_id\":") + 8;
    const toggleIdPlus = toggle.getAttribute("data-gt").slice(ad_id_start);
    const ad_id_end = Math.min(
      toggleIdPlus.indexOf(","),
      toggleIdPlus.indexOf("}")
    );

    this.toggleId = toggleIdPlus.slice(0, ad_id_end);
    if (!this.toggleId) return this.promote(states.ERROR, errors.NO_TOGGLE);

    if (adCache.has(this.toggleId)) return this.promote(states.CACHED);
    this.idFinder = new SidebarFinder(this.toggleId, toggle, control);
    this.promote(states.MENU);
  }

  menu() {
    this.idFinder.tick();
    switch (this.idFinder.state) {
      case states.INITIAL:
      case states.MENU:
        break;
      case states.DONE:
        this.ad.id = this.idFinder.id;
        this.targetingUrl = this.idFinder.url;
        this.states.push(this.idFinder.states);
        this.promote(states.TARGETING);
        break;
      default:
        this.states.push(this.idFinder.states);
        this.promote(states.ERROR, errors.INVARIANT);
    }
  }

  targeting() {
    if (!this.targetingUrl) return this.promote(states.ERROR, errors.INVARIANT);
    if (targetingCache.has(this.targetingUrl)) {
      this.ad.targeting = targetingCache.get(this.targetingUrl);
      return this.promote(states.DONE);
    }
    if (targetingBlocked) return this.promote(states.DONE);

    const built = grabVariable(
      url => {
        let parsed = new (window.require("URI"))(url);
        localStorage.setItem("url", url);
        let req = new window.AsyncRequest()
          .setURI(url)
          .setData(parsed)
          .setMethod("GET")
          .setRelativeTo(document.body)
          .setNectarModuleDataSafe(document.body)
          .setReadOnly(true);
        Object.assign(req.data, { __asyncDialog: 1 });
        Object.assign(req.data, window.require("getAsyncParams")(req.method));
        req._setUserActionID();
        req.setNewSerial();
        return req.uri.addQueryData(req.data).toString();
      },
      [this.targetingUrl]
    );

    const req = new XMLHttpRequest();
    req.onreadystatechange = () => {
      if (req.readyState === 4) {
        try {
          const targeting = cleanAd(
            JSON.parse(req.response.replace("for (;;);", ""))["jsmods"][
              "markup"
            ][0][1]["__html"]
          );
          if (!targeting) return this.promote(states.DONE);
          targetingCache.set(this.targetingUrl, targeting);
          this.ad.targeting = targeting;
          this.promote(states.DONE);
        } catch (e) {
          if (DEBUG) console.log("error getting targeting", e);
          targetingBlocked = true;
          setTimeout(() => (targetingBlocked = false), 15 * 16 * 1000);
          this.promote(states.DONE);
        }
      }
    };
    this.promote(states.WAIT_TARGETING);
    req.open("GET", "https://www.facebook.com" + built, true);
    req.send();
  }

  waitTargeting() {}

  notAnAd() {
    this.promote(states.ERROR, errors.NOT_AN_AD);
  }

  done() {
    if (this.ad.id == "1234"){
      this.ad.id = this.node.closest(".sponsored_ad").id;
    }
    if (DEBUG) {
      console.log(this.states);
      this.node.style.color = "#ff0000";
    }
    adCache.set(this.toggleId, this.ad);
    this.stop();
    this.resolve(this.ad);
  }

  error() {
    if (DEBUG) {
      console.error(this.message);
      console.error(this.states);
    }
    this.stop();
    this.reject(this.message);
  }
}

// Sub state machine for menu parsing
class IdFinder extends StateMachine {
  constructor(toggleId, toggle) {
    super();
    this.toggleId = toggleId;
    this.toggle = toggle;
    this.promote(states.INITIAL);
  }

  tick() {
    switch (this.state) {
      case states.INITIAL:
        this.click();
        break;
      case states.MENU:
        this.menu();
        break;
      case states.ERROR:
        this.error();
        break;
      default:
        this.error();
        this.promote(states.ERROR, errors.INVARIANT);
    }
  }

  click() {
    refocus(() => this.toggle.click());
    // 2018/01/21: 
    // this is just a hotfix, skipping this whole routine,
    // since you (suspiciously) can't .click() the `...` button anymore    
    this.promote(states.DONE);
    targetingBlocked = true;
    this.url = 'fake';
    this.id = "1234";
    // uncomment this after the hotfix is no longer necessary
    //this.promote(states.MENU);
  }

  close() {
    refocus(() => this.toggle.click());
    this.promote(states.DONE);
  }

  error() {
    refocus(() => this.toggle.click());
    this.promote(states.ERROR, errors.NO_ID);
  }

  menu() {
    const menu = this.menuFilter();
    // No menu yet, try again.
    if (!menu) return;
    const li = Array.from(menu.querySelectorAll("li")).filter(this.filter)[0];
    if (!li) return;
    const endpoint = li.querySelector("a");
    if (!endpoint) return;
    const url = endpoint.getAttribute("ajaxify");
    try {
      this.id = new URL("https://facebook.com" + url).searchParams.get("id");
      if (this.id) {
        this.url = url;
        this.close();
      } else {
        this.error();
      }
    } catch (e) {
      this.error();
    }
  }

  menuFilter() {
    throw "Unimplemented!";
  }

  filter() {
    throw "Unimplemented!";
  }
}

export class TimelineFinder extends IdFinder {
  menuFilter() {
    return Array.from(document.querySelectorAll(".uiLayer")).filter(
      a => a.getAttribute("data-ownerid") === this.toggleId
    )[0];
  }

  filter(it) {
    return (
      it.getAttribute("data-feed-option-name") === "FeedAdSeenReasonOption"
    );
  }
}

export class SidebarFinder extends IdFinder {
  constructor(id, toggle, control) {
    super(id, toggle);
    this.control = control;
  }

  menuFilter() {
    return this.control;
  }

  filter(it) {
    return it.getAttribute("data-label") === "Why am I seeing this?";
  }
}

// This function cleans all the elements that could leak user data
// before sending to the server. It also removes any attributes that
// could have personal data so we end up with a clean dom tree.
const selectors = [
  "video",
  "input",
  "button",
  "iframe",
  "a[href=\"\"]",
  ".accessible_elem",
  ".uiLikePagebutton",
  ".uiPopOver",
  ".uiCloseButton",
  ".uiChevronSelectorButton",
  "h5._1qbu",
  ".commentable_item"
].join(", ");

const cleanAd = html => {
  let node = document.createElement("div");
  node.innerHTML = html;

  // We're not saving video ads for now, we don't need buttons, hidden forms,
  // or like links
  Array.from(node.querySelectorAll(selectors)).forEach(i => i.remove());
  // remove attributes
  const killAttrs = node => {
    Array.from(node.attributes).forEach(attr => {
      if (
        attr.name !== "id" &&
        attr.name !== "class" &&
        attr.name !== "src" &&
        attr.name !== "href" &&
        attr.name !== "data-hovercard"
      )
        node.removeAttribute(attr.name);

      // remove tracking get variables from links and l.facebook.com
      if (attr.name === "href") {
        try {
          if (attr.value == "#") {
            return;
          }
          let url = new URL(attr.value);
          if (url.host === "l.facebook.com")
            url = new URL(new URLSearchParams(url.search).get("u"));
          if (url.origin && url.pathname) {
            node.setAttribute(attr.name, url.origin + url.pathname);
          } else {
            node.removeAttribute(attr.name);
          }
        } catch (e) {
          node.removeAttribute(attr.name);
        }
      } else if (attr.name === "data-hovercard") {
        try {
          let url = new URL(attr.value, window.location); // it's a relative URL, so we have to give it a base or it errors out.
          // if (DEBUG) console.log("hovercard", url, url.searchParams.get("id"));
          if (url.pathname.indexOf("/ajax/hovercard/page.php") === 0) {
            // for links with a href="#" and data-hovercard="/ajax/hovercard/page.php?id=1234567890"
            // keep the data-hovercard attr.
            node.setAttribute(
              attr.name,
              "https://www.facebook.com/" + url.searchParams.get("id")
            );
          } else {
            node.removeAttribute(attr.name);
          }
        } catch (e) {
          node.removeAttribute(attr.name);
        }
      }
    });
    // walk through the tree.
    Array.from(node.children).forEach(killAttrs);
  };
  Array.from(node.children).forEach(killAttrs);
  return node.innerHTML.replace(/&amp;/g, "&");
};

/* 
        Facebook's "Sponsored" markup is actually "SpSonSsoSredSSS".
        All the extra "S" are hidden with CSS. In other languages, that intrusive letter is not "S",
        but rather the first letter of the word for "Sponsored", e.g. "C" for fr-CA's "Commandité".
        The intrusive letters and the real letters are all in spans. Both have two classes, but those
        classes differ per-person. 
        Until 12/21/2018ish, we could distinguish the intrusive letter from real letters by removing any single-letter spans.
        
        Additionally, for some users, all posts (both ads and friends' vacation pictures) contain the "Sponsored" markup but,
        that markup is only visible in actual ads. So we check the height/width of the Sponsored div is non-zero
        if it is, we identify it as an ad, otherwise, it's a sneaky sneaky red herring.
        (are you the FB engineer who came up with this? Clever! but... signal me (205) 286-2366 )

        But then Facebook added an extra span at the end that says "SS". So that doesn't work anymore. 
        So now we filter each by whether it's visible.
        FYI if you're an FB engineer reading this, please reflect on whether interfering with political ad transparency
        efforts is something you'll be proud of! And/or Signal or call me 205-286-2366... or PGP at jeremy at jeremybmerrill dot com
      */

const sponsored_translations = [
  "Gesponsord",
  "Sponsored", // en-US
  "SponsoredSS", // en-US, testing
  "Gesponsert",
  "Sponsrad", // sv
  "Sponsorlu", // turkish?
  "Sponsoroitu", // fn?
  "مُموَّل", // ar
  "Sponsoreret", // dk
  "Sponsorizzata", //it
  "Chartered", // en-PIRATE :)
  "Commandité", // fr-CA
  "Sponsorisé", // fr-FR
  "Patrocinado", // pt-BR
  "Apmaksāta", // lv-LV (cuts off reklāma as part of the thing that gets rid of the U.S. disclaimer)
  "რეკლამა", // ka-GE
  "Реклама", // ru
  "Publicidad", // es
  "ממומן" //he
];
export const checkSponsor = node => {
  return Array.from(node.querySelectorAll(".clearfix a, .ego_section a")).some(
    realNode => {
      //let a = realNode.cloneNode(true);
      const canary = Array.from(realNode.querySelectorAll("span,div"));

      const visibleCanaryText = Array.from(canary).reduce((acc, elem) => {
        return (
          acc +
          (elem &&
          elem.offsetHeight > 0 &&
          elem.offsetWidth > 0 &&
          elem.children &&
          window.getComputedStyle(elem).getPropertyValue('opacity') !== "0" && 
          // ^^
          // Clever, Facebook engineer! You've got an INCREDIBLE sense of JavaScript
          // and CSS's nooks and crannies. I feel like I'm playing chess with a grandmaster.
          // Let's talk. jeremybmerrill@jeremybmerrill.com PGP: 0x7780C4694F621BA0
          // - Jeremy, 1/22/2019
          elem.children.length === 0
            ? elem.textContent
            : "")
        );
      }, "");

      const text = visibleCanaryText.replace(/^\s+|\s+$/g, "").split(" ")[0];

      // N.B. Facebook has previously experimented with putting the word "Sponsored" in the CSS content rule
      // if that shows up again, see bbe70267b8d3d375d451f2bbff219f89ca5c7d23 for ways to detect it
      const is_sponsored = sponsored_translations.some(sponsor => {
        if (text.indexOf(sponsor) === 0) return true;
        return false;
      });
      return is_sponsored;
    }
  );
};

// We have to do this because content scripts can't read window variables
const grabVariable = (fn, args) => {
  let script = document.createElement("script");
  script.textContent =
    "localStorage.setItem(\"pageVariable\", (" +
    fn +
    ").apply(this, " +
    JSON.stringify(args) +
    "));";
  script.setAttribute("id", "pageVariable");
  (document.head || document.documentElement).appendChild(script);
  script.remove();
  return localStorage.getItem("pageVariable");
};

// We want to minimize the impact of a user's experience using facebook, so this function tries to
// restore the state of the page when the extension clicks around.
const refocus = cb => {
  const focus = document.activeElement;
  const ranges = [];
  const selection = window.getSelection();
  for (let i = 0; i < selection.rangeCount; i++) {
    let range = selection.getRangeAt(i);
    ranges.push([
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset
    ]);
  }
  cb();
  if (focus) focus.focus();
  if (ranges.length > 0) {
    const newSelection = window.getSelection();
    newSelection.removeAllRanges();
    ranges.forEach(range_attrs => {
      const range = document.createRange();
      range.setStart(range_attrs[0], range_attrs[1]);
      range.setEnd(range_attrs[2], range_attrs[3]);
      newSelection.addRange(range);
    });
  }
};

export const parser = node =>
  new Promise((resolve, reject) => new Parser(node, resolve, reject).start());
