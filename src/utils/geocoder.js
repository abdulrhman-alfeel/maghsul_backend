import fetch from 'node-fetch';

export async function reverseGeocode(lat, lng) {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ar`, {
      headers: {
        'User-Agent': 'LaundryApp/1.0',
      },
    });
    const data = await response.json();
    if (data && data.display_name) {
      // Return a shortened version (e.g. City, Neighborhood) to avoid massive strings, or the full display_name
      let name = data.display_name;
      // We can split by comma and take first 3 elements for readability
      const parts = name.split(',');
      if (parts.length > 3) {
        name = parts.slice(0, 3).join(',');
      }
      return name;
    }
  } catch (error) {
    console.error('Geocoder error:', error.message);
  }
  return null;
}
