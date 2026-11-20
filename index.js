const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers for Stremio
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Handle OPTIONS preflight
app.options('*', (req, res) => {
  res.status(200).send();
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json({
    "name": "Latino Stream Addon",
    "id": "com.latino.streamer",
    "version": "1.0.0",
    "description": "Stremio addon for Latino streaming sites",
    "type": "video",
    "resource": "https://{id}.json",
    "id_prefixes": ["tt", ""],
    "catalogs": [
      { "id": "movies", "name": "Movies", "parent_id": "movies" },
      { "id": "series", "name": "Series", "parent_id": "series" },
      { "id": "anime", "name": "Anime", "parent_id": "anime" }
    ],
    "behaviour_hints": {
      "previews": ["https://image.tmdb.org/t/p/w300"]
    }
  });
});

// Catalog: Movies
app.get('/catalog/movies.json', async (req, res) => {
  try {
    const movies = [
      { id: 'tt0499549', name: 'Fight Club', year: '1999', posters: ['https://image.tmdb.org/t/p/w300'] },
      { id: 'tt0944947', name: 'Game of Thrones', year: '2011', posters: ['https://image.tmdb.org/t/p/w300'] },
      { id: 'tt1386570', name: 'Interstellar', year: '2014', posters: ['https://image.tmdb.org/t/p/w300'] },
    ];
    res.json(movies);
  } catch (err) {
    console.error('Error fetching movies catalog:', err.message);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// Catalog: Series
app.get('/catalog/series.json', async (req, res) => {
  try {
    const series = [
      { id: 'tt0944947', name: 'Game of Thrones', year: '2011', posters: ['https://image.tmdb.org/t/p/w300'] },
      { id: 'tt1392768', name: 'The Mandalorian', year: '2019', posters: ['https://image.tmdb.org/t/p/w300'] },
    ];
    res.json(series);
  } catch (err) {
    console.error('Error fetching series catalog:', err.message);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// Catalog: Anime
app.get('/catalog/anime.json', async (req, res) => {
  try {
    const anime = [
      { id: 'tt1569564', name: 'Dragon Ball Super', year: '2015', posters: ['https://image.tmdb.org/t/p/w300'] },
      { id: 'tt7951738', name: 'Chainsaw Man', year: '2022', posters: ['https://image.tmdb.org/t/p/w300'] },
    ];
    res.json(anime);
  } catch (err) {
    console.error('Error fetching anime catalog:', err.message);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// Stream endpoint - movie
app.get('/stream/movie/:imdbId.json', async (req, res) => {
  try {
    const imdbId = req.params.imdbId;
    const stream = await resolveStream('movie', imdbId);
    if (stream && stream.streams && stream.streams.length > 0) {
      res.json(stream);
    } else {
      res.status(404).json({ error: 'No stream found' });
    }
  } catch (err) {
    console.error('Error fetching movie stream:', err.message);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

// Stream endpoint - series
app.get('/stream/series/:imdbId.json', async (req, res) => {
  try {
    const imdbId = req.params.imdbId;
    const stream = await resolveStream('series', imdbId);
    if (stream && stream.streams && stream.streams.length > 0) {
      res.json(stream);
    } else {
      res.status(404).json({ error: 'No stream found' });
    }
  } catch (err) {
    console.error('Error fetching series stream:', err.message);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

// Stream endpoint - anime
app.get('/stream/anime/:imdbId.json', async (req, res) => {
  try {
    const imdbId = req.params.imdbId;
    const stream = await resolveStream('anime', imdbId);
    if (stream && stream.streams && stream.streams.length > 0) {
      res.json(stream);
    } else {
      res.status(404).json({ error: 'No stream found' });
    }
  } catch (err) {
    console.error('Error fetching anime stream:', err.message);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

// Resolve stream function
async function resolveStream(type, imdbId) {
  const sites = [
    { name: 'flixlatam', fn: getFlixLatamStream },
    { name: 'area-documental', fn: getAreaDocumentalStream },
    { name: 'documaniatv', fn: getDocumaniatvStream },
    { name: 'seriesperu', fn: getSeriesPeruStream },
    { name: 'doramasyt', fn: getDoramasytStream }
  ];

  for (const site of sites) {
    try {
      const url = await site.fn(imdbId);
      if (url) {
        return {
          streams: [
            {
              url,
              id: `stream-${type}-${imdbId}-${site.name}`
            }
          ]
        };
      }
    } catch (err) {
      console.error(`Error checking ${site.name}:`, err.message);
      continue;
    }
  }
  return { streams: [] };
}

// Site stream functions
async function getFlixLatamStream(imdbId) {
  return `https://flixlatam.com/stream/${imdbId}/master.m3u8`;
}

async function getAreaDocumentalStream(imdbId) {
  return `https://www.area-documental.com/player.php?titulo=${imdbId}`;
}

async function getDocumaniatvStream(imdbId) {
  return `https://documaniatv.com/player.php?titulo=${imdbId}`;
}

async function getSeriesPeruStream(imdbId) {
  return `https://seriesperu.com/player.php?titulo=${imdbId}`;
}

async function getDoramasytStream(imdbId) {
  return `https://www.doramasyt.com/player.php?titulo=${imdbId}`;
}

// Serve web configuration interface
app.get('/config', (req, res) => {
  res.send('<html><body><h1>Latino Stream Addon</h1><p>Catalogs: movies, series, anime</p><p>Stream extraction URLs configured for: flixlatam, area-documental, documaniatv, seriesperu, doramasyt</p></body></html>');
});

// Default route
app.get('*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Latino Stream Addon running on port ${port}`);
});

module.exports = app;
