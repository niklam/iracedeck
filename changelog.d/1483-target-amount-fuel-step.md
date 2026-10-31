---
category: Bug Fixes
weight: 50
---

A **Fuel Service** dial in **Target Amount** mode no longer finishes a stop under the target in cars that fuel in whole gallons, such as the Global MX-5 Cup. iRacing rounded the request to the nearest gallon, which could leave you up to half a gallon short; now the request follows the car's fuel step and is stepped up until it covers the target. See [Fuel Service](/docs/actions/pit-service/fuel-service/).
