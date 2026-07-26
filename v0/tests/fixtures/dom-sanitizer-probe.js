(function () {
  const policy = window.__rewriteState;
  const sanitizer = window.WritCraftHtmlSanitizer;

  function sanitize(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    sanitizer.sanitizeFragment(template.content, policy);
    return template.content;
  }

  window.runWritCraftDomSanitizerProbe = async function () {
    window.__writcraftProbePwned = 0;
    const recovery = sanitize(`
      <script>window.__writcraftProbePwned=1</script>
      <style>body{display:none}</style>
      <iframe srcdoc="<script>parent.__writcraftProbePwned=2<\/script>"></iframe>
      <form action="javascript:alert(1)"><input autofocus onfocus="window.__writcraftProbePwned=3"></form>
      <svg onload="window.__writcraftProbePwned=4"><animate attributeName="href" values="javascript:alert(1)"></animate><a xlink:href="javascript:alert(1)">svg text</a></svg>
      <math><mtext><img src=x onerror="window.__writcraftProbePwned=5">math text</mtext></math>
      <p id="editor" name="writCraft" style="background:url(https://example.invalid/x)" onclick="window.__writcraftProbePwned=6">正文</p>
      <a id="unsafe" href="javascript:alert(1)" target="_blank">unsafe</a>
      <a href="//example.invalid/path">protocol relative</a>
      <a id="safe" href="https://example.com/path" target="_blank">safe</a>
      <img id="remote" src="https://example.invalid/tracker.png" srcset="https://example.invalid/2x.png 2x" onerror="window.__writcraftProbePwned=7">
      <img id="svg-data" src="data:image/svg+xml;base64,PHN2Zy8+">
      <img id="png-data" src="data:image/png;base64,iVBORw0KGgo=" width="120" height="99999" alt="safe image">
    `);
    const mount = document.getElementById('mount');
    mount.replaceChildren(recovery.cloneNode(true));
    await new Promise(resolve => setTimeout(resolve, 100));

    const markdown = '[bad](javascript:alert(1)) <img src=x onerror="window.__writcraftProbePwned=8">';
    const markdownFragment = sanitize(window.marked.parse(policy.escapeMarkdownSource(markdown)));
    const markdownHost = document.createElement('div');
    markdownHost.append(markdownFragment.cloneNode(true));

    const reparsed = sanitize(mount.innerHTML);
    const reparseHost = document.createElement('div');
    reparseHost.append(reparsed.cloneNode(true));

    const oversized = document.createElement('template');
    oversized.innerHTML = `<span>${'<i>x</i>'.repeat(10001)}</span>`;
    sanitizer.sanitizeFragment(oversized.content, policy);

    return {
      pwned: window.__writcraftProbePwned,
      activeCount: mount.querySelectorAll('script,style,iframe,object,embed,form,input,button,textarea,select,meta,link,base').length,
      namespaceCount: mount.querySelectorAll('svg,math,animate,use,foreignObject').length,
      foreignNamespaceCount: [...mount.querySelectorAll('*')].filter(node => node.namespaceURI !== 'http://www.w3.org/1999/xhtml').length,
      eventAttributeCount: [...mount.querySelectorAll('*')].flatMap(node => [...node.attributes]).filter(attr => /^on/i.test(attr.name)).length,
      clobberAttributeCount: mount.querySelectorAll('[id],[name]').length,
      unsafeHref: [...mount.querySelectorAll('a')].find(node => node.textContent === 'unsafe')?.getAttribute('href') || null,
      safeHref: [...mount.querySelectorAll('a')].find(node => node.textContent === 'safe')?.getAttribute('href') || null,
      safeRel: [...mount.querySelectorAll('a')].find(node => node.textContent === 'safe')?.getAttribute('rel') || null,
      protocolRelativeHref: [...mount.querySelectorAll('a')].find(node => node.textContent === 'protocol relative')?.getAttribute('href') || null,
      remoteSrc: [...mount.querySelectorAll('img')].find(node => node.getAttribute('alt') !== 'safe image')?.getAttribute('src') || null,
      svgDataCount: [...mount.querySelectorAll('img')].filter(node => /^data:image\/svg/i.test(node.getAttribute('src') || '')).length,
      pngDataCount: [...mount.querySelectorAll('img')].filter(node => /^data:image\/png/i.test(node.getAttribute('src') || '')).length,
      invalidHeight: mount.querySelector('img[alt="safe image"]')?.getAttribute('height') || null,
      recoveryText: mount.textContent.replace(/\s+/g, ' ').trim(),
      markdownActiveCount: markdownHost.querySelectorAll('img,script,iframe').length,
      markdownUnsafeHref: markdownHost.querySelector('a')?.getAttribute('href') || null,
      markdownText: markdownHost.textContent,
      reparseDangerCount: reparseHost.querySelectorAll('script,style,iframe,object,embed,form,input,meta,link,base,svg,math,[onload],[onclick],[onerror]').length,
      oversizedElementCount: oversized.content.querySelectorAll('*').length,
      oversizedTextLength: oversized.content.textContent.length,
    };
  };
})();
