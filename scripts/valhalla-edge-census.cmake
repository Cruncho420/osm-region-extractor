# Included by the exact core project; no tracked core files are changed.
if(CMAKE_PROJECT_NAME STREQUAL "valhalla" AND NOT TARGET rods_edge_census)
  add_executable(rods_edge_census "${CMAKE_CURRENT_LIST_DIR}/valhalla-edge-census.cc")
  set_target_properties(rods_edge_census PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
  target_link_libraries(rods_edge_census valhalla)
endif()
