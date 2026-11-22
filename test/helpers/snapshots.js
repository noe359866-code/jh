// Fragmentos reales (recortados) de las respuestas de las fuentes, para que los
// tests validen los parsers sin red. Los nombres y URLs son públicas.

const ejaPage = `<!doctype html><html><body>
<div class="card h-100">
  <div class="card-body text-center">
    <h5 class="card-title"><span class="text-muted">La 1 Canarias</span></h5>
    <p class="card-text"><div class="d-flex align-items-center justify-content-between flex-wrap">
      <small><a href="?country=es">&#127466;&#127480; &nbsp; Spain</a></small>
      <div><small><a href="?language=spa">Spanish</a></small></div>
    </div></p>
    <div class="video"><video class="video-js vjs-default-skin" controls poster="/snaps/70cb.png" preload="none" data-setup='{}'>
      <source src="https://rtvelivestream.rtve.es/rtvesec/can/la1_can_main.m3u8#70cb0a42" type="application/x-mpegURL">
    </video></div>
  </div>
</div>
<div class="card h-100">
  <div class="card-body text-center">
    <h5 class="card-title"><span class="text-muted">La 1 Catalunya</span></h5>
    <p class="card-text"><div class="d-flex align-items-center justify-content-between flex-wrap">
      <small><a href="?country=es">Spain</a></small>
      <div><small><a href="?language=cat">Catalan</a></small></div>
    </div></p>
    <div class="video"><video class="video-js" poster="/snaps/f377.png"><source src="https://example.invalid/cat.m3u8#f377" type="application/x-mpegURL"></video></div>
  </div>
</div>
<div class="card h-100">
  <div class="card-body text-center">
    <h5 class="card-title"><span class="text-muted">Real Madrid TV</span></h5>
    <p class="card-text"><div><small><a href="?country=es">Spain</a></small><div><small><a href="?language=spa">Spanish</a></small></div></div></p>
    <div class="video"><video class="video-js" poster="/snaps/fb98.png"><source src="http://rmtv.example/hls/live/master.m3u8#fb98" type="application/x-mpegURL"></video></div>
    <i class="bi bi-badge-hd"></i>
  </div>
</div>
<small><i>remix the narrative with 144 live iptv channels from Spain</i></small>
</body></html>`;

const iptvcatPage = `<html><body><table><tbody class="streams_table">
<tr class="border-solid belongs_to_2741546">
  <td class="flag"><a href="/spain__1"><img src="assets/images/flags/es.png" title="Spain"></a></td>
  <td><span class="channel_name" data-popup="popover" data-content=" &lt;td&gt;x&lt;/td&gt; ">101tv Antequera (720p) [Geo-blocked]</span></td>
  <td><table><tbody><tr><td><span data-clipboard-text="https://list.iptvcat.net/my_list/s/aaa.m3u8">Copy</span></td></tr></tbody></table></td>
</tr>
<tr class="border-solid belongs_to_2721470">
  <td class="flag"><a href="/spain__1"><img src="assets/images/flags/es.png" title="Spain"></a></td>
  <td><span class="channel_name" data-popup="popover">La 1</span></td>
  <td><table><tbody><tr><td><span data-clipboard-text="https://list.iptvcat.net/my_list/s/bbb.m3u8">Copy</span></td></tr></tbody></table></td>
</tr>
<tr class="border-solid belongs_to_999">
  <td class="flag"><a href="/spain__1"><img src="assets/images/flags/es.png" title="Spain"></a></td>
  <td><span class="channel_name">Sin lista</span></td>
</tr>
</tbody></table>
<a href="/spain__1/2">2</a>
<a href="/mexico__6">Mexico</a>
<a href="/italy__3">Italy</a>
</body></html>`;

const tvgardenJson = JSON.stringify([
  { nanoid: 'a1', name: '28 kanala', stream_urls: ['https://streaming.28kanala.eus/hls/z.m3u8'], youtube_urls: [], languages: ['eus'], country: 'es', isGeoBlocked: false },
  { nanoid: 'a2', name: 'La 1', stream_urls: ['https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8', 'https://rtvelivestream-clnx.rtve.es/rtvesec/la1/la1_main.m3u8'], youtube_urls: [], languages: ['spa'], country: 'es', isGeoBlocked: false },
  { nanoid: 'a3', name: 'Solo YouTube', stream_urls: [], youtube_urls: ['https://youtube.com/watch?v=x'], languages: ['spa'], country: 'es', isGeoBlocked: false }
]);

const globalFreeChannel = `<html><head><title>La 1 Live - Watch Free Online</title></head><body><script>
self.__TSR=($R=>{$R[14]={channel:$R[15]={id:"La1.es",name:"La 1",network:"RTVE",country:"ES",subdivision:null,logo:null},streams:$R[16]=[$R[17]={id:30104,channel_id:"La1.es",url:"https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8",timeshift:null,http_referrer:null,user_agent:null},$R[18]={id:30105,channel_id:"La1.es",url:"https://ztnr.rtve.es/ztnr/1694255.m3u8",timeshift:null,http_referrer:"https://www.rtve.es/",user_agent:null}],streamStatus:"available"};});
</script></body></html>`;

const globalFreeListing = `<html><body><div class="grid">
<a href="/channels/La1.es"><div>La 1</div></a>
<a href="/channels/24Horas.es"><div>24 Horas</div></a>
<a href="/channels/RealMadridTV.es"><div>Real Madrid TV</div></a>
<a href="/countries/argentina">Argentina</a>
</div></body></html>`;

const tvenvivoHome = `<html><body><div class="grid">
<a href="https://www.tvenvivo.org/tudn-en-vivo-online.php"><div class="card"><img src="/imge/tudn.webp" alt="TUDN"><div>TUDN</div></div></a>
<a href="/liga-1-en-vivo-online.php"><div class="card"><img src="/imge/liga1.webp"><span>Liga 1</span></div></a>
<a href="/redes/">Redes</a>
</div></body></html>`;

const tvenvivoCore = `<html><body><script>const p="/live/core.php?canal=tudn";</script><iframe src="https://deportes.example.com/stream.php?canal=tudn&amp;target=1&amp;sig=abc"></iframe></body></html>`;

const tvenvivoEmbed = `<html><body><video id="video"></video><script>
var src = "https:\\/\\/deportes.example.com\\/playlist\\/1\\/index.m3u8?token=abc-def";
</script></body></html>`;

const daddyList = `<html><body><div class="grid">
<a class="card" href="/watch.php?id=51" data-title="abc usa"><div class="card__title">ABC USA</div><div>ID: 51</div></a>
<a class="card" href="/watch.php?id=700" data-title="la liga"><div class="card__title">LaLiga TV</div><div>ID: 700</div></a>
<a class="card" href="/watch.php?id=701" data-title="dazn f1"><div class="card__title">DAZN F1</div><div>ID: 701</div></a>
</div></body></html>`;

const daddyWatch = `<html><body><div class="watch__playerFrame"><iframe src="https://thedaddy.li/stream/stream-700.php"></iframe></div></body></html>`;
const daddyPlayer = `<html><body><iframe src="https://dembed.st/premiumtv/daddy.php?id=700"></iframe></body></html>`;
const daddyEmbed = `<html><script>const SRC = "https://edge.example.top/premium700/index.m3u8"; const EDGE = "https://edge.example.top"; const CHANNEL = "premium700";</script></html>`;

const live24Json = JSON.stringify([
  { channel_name: 'DAZN F1 ES', image: 'https://logos.example/dazn.png', url: 'https://hesgoalsss.blogspot.com/p/ntv.html?id=DAZNF1ES', country: 'Spain', category: 'Sports' },
  { channel_name: 'NFL RedZone USA', image: '', url: 'https://hesgoalsss.blogspot.com/p/ntv.html?id=NFL', country: 'USA', category: 'Sports' },
  { channel_name: 'Azteca 7', image: 'https://logos.example/azteca.png', url: 'https://hesgoalsss.blogspot.com/p/ntv.html?id=AZ7', country: 'Mexico', category: 'General' }
]);

module.exports = {
  ejaPage, iptvcatPage, tvgardenJson, globalFreeChannel, globalFreeListing,
  tvenvivoHome, tvenvivoCore, tvenvivoEmbed, daddyList, daddyWatch, daddyPlayer,
  daddyEmbed, live24Json
};
