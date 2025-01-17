importScripts("./dexie.js")
var db = new Dexie("breadboard")
db.version(1).stores({
  files: "file_path, agent, model_name, root_path, prompt, btime, mtime, *tokens",
  folders: "&name",
  checkpoints: "&root_path, btime",
  settings: "key, val",
  favorites: "query"
})
const esc = (str) => {
  return str
		.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
		.replace(/-/g, '\\x2d');
}
function applyFilter(q, filters) {
  if (filters.length > 0) {
    for(let filter of filters) {
      if (filter.before) {
        q = q.and("btime").belowOrEqual(new Date(filter.before).getTime())
      } else if (filter.after) {
        q = q.and("btime").aboveOrEqual(new Date(filter.after).getTime())
      } else if (filter.model_name) {
        q = q.and((item) => {
          return new RegExp(esc(filter.model_name), "i").test(item.model_name)
        })
      } else if (filter.agent) {
        //q = q.and("agent").startsWithIgnoreCase(filter.agent)
        q = q.and((item) => {
          return item.agent && item.agent.toLowerCase().startsWith(filter.agent.toLowerCase())
        })
      } else if (filter.file_path) {
        q = q.and((item) => {
          return new RegExp(esc(filter.file_path), "i").test(item.file_path)
        })
      }
    }
  }
  return q.primaryKeys()
}

const preprocess_query = (phrase) => {
  let fp_re = /file_path:"(.+)"/g
  let mn_re = /model_name:"(.+)"/g
  let tag_re = /tag:"([^"]+)"/g
  let fp_placeholder = "file_path:" + Date.now()
  let mn_placeholder = "model_name:" + Date.now()
  let test = fp_re.exec(phrase)
  let fp_captured
  if (test && test.length > 1) {
    phrase = phrase.replace(fp_re, fp_placeholder)
    fp_captured = test[1]
  }
  test = mn_re.exec(phrase)
  let mn_captured
  if (test && test.length > 1) {
    phrase = phrase.replace(mn_re, mn_placeholder)
    mn_captured = test[1]
  }

  let tag_captured = {}
  let to_replace = []
  while(true) {
    let test = tag_re.exec(phrase)
    if (test) {
      let captured = test[1]
      let tag_placeholder = "tag:" + Math.floor(Math.random() * 100000)
      to_replace.push(tag_placeholder)
      tag_captured[tag_placeholder] = captured
    } else {
      break;
    }
  }
  let tag_re2 = /tag:"([^"]+)"/
  for(let tag_placeholder of to_replace) {
    phrase = phrase.replace(tag_re2, tag_placeholder)
  }

  let prefixes = phrase.split(" ").filter(x => x && x.length > 0)
  const converted = []
  for (let prefix of prefixes) {
    if (prefix.startsWith("model_name:")) {
      if (mn_captured) {
        converted.push("model_name:" + prefix.replace(/model_name:[0-9]+/, mn_captured))
      } else {
        converted.push(prefix)
      }
    } else if (prefix.startsWith("file_path:")) {
      if (fp_captured) {
        converted.push("file_path:" + prefix.replace(/file_path:[0-9]+/, fp_captured))
      } else {
        converted.push(prefix)
      }
    } else if (prefix.startsWith("tag:")) {
      if (tag_captured[prefix]) {
        converted.push("tag:" + prefix.replace(/tag:[0-9]+/, tag_captured[prefix]))
      } else {
        converted.push(prefix)
      }
    } else {
      converted.push(prefix)
    }
  }
  return converted
}

function find (phrase) {

  // replace all 
  // file_path:".*"
  // model_name:".*"
  // with 
  // file_path:Date.now()
  // model_name:Date.now()

  // run the split
  // replace the pattern after the split

  let prefixes = preprocess_query(phrase)
  let tokens = []
  let filters = []
  for(let prefix of prefixes) {
    if (prefix.startsWith("before:")) {
      filters.push({
        before: prefix.replace("before:", "").trim()
      })
    } else if (prefix.startsWith("after:")) {
      filters.push({
        after: prefix.replace("after:", "").trim()
      })
    } else if (prefix.startsWith("model_name:")) {
      filters.push({
        model_name: prefix.replace("model_name:", "").trim()
      })
    } else if (prefix.startsWith("agent:")) {
      filters.push({
        agent: prefix.replace("agent:", "").trim()
      })
    } else if (prefix.startsWith("file_path:")) {
      filters.push({
        file_path: prefix.replace("file_path:", "").trim()
      })
    } else {
      tokens.push(prefix)
    }
  }

  return db.transaction('r', db.files, function*() {
    let promises
    if (tokens.length > 0) {
      promises = tokens.map((token) => {
        let q = db.files.where('tokens').startsWithIgnoreCase(token)
        return applyFilter(q, filters)
      })
    } else {
      let q = db.files.toCollection()
      promises = [applyFilter(q, filters)]
    }
    const results = yield Dexie.Promise.all(promises)
    const reduced = results.reduce ((a, b) => {
      const set = new Set(b);
      return a.filter(k => set.has(k));
    });
    return yield db.files.where(':id').anyOf (reduced).toArray();
  });
}
addEventListener("message", async event => {
  const { query, sorter } = event.data;
  let res = []
  if (query) {
    res = await find(query, sorter)
    if (sorter.direction > 0) {
      if (sorter.compare === 0) {
        res.sort((x, y) => { return x[sorter.column] - y[sorter.column] })
      } else if (sorter.compare === 1) {
        res.sort((x, y) => {
          let xx = (x[sorter.column] && typeof x[sorter.column] === 'string' ? x[sorter.column] : "")
          let yy = (y[sorter.column] && typeof y[sorter.column] === 'string' ? y[sorter.column] : "")
          return xx.localeCompare(yy)
        })
      }
    } else if (sorter.direction < 0) {
      if (sorter.compare === 0) {
        res.sort((x, y) => { return y[sorter.column] - x[sorter.column] })
      } else if (sorter.compare === 1) {
        res.sort((x, y) => {
          let xx = (x[sorter.column] && typeof x[sorter.column] === 'string' ? x[sorter.column] : "")
          let yy = (y[sorter.column] && typeof y[sorter.column] === 'string' ? y[sorter.column] : "")
          return yy.localeCompare(xx)
        })
      }
    }
  } else {
    if (sorter.direction > 0) {
      res = await db.files.orderBy(sorter.column).toArray()
    } else if (sorter.direction < 0) {
      res = await db.files.orderBy(sorter.column).reverse().toArray()
    }
  }
  postMessage(res)
});
